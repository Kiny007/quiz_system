/**
 * ============================================================
 *  Quiz Master — 服务端 (Server-Authoritative + Multi-Room)
 *  Node.js + Express + Socket.io
 *
 *  核心原则：
 *    1. 所有权威状态由服务端 rooms Map 统一维护
 *    2. 客户端只发送动作指令 (action_*)，不推整体状态
 *    3. 服务端收到动作后更新状态，再广播 sync_state 给全房间
 *    4. 抢答判定以服务端接收时间 serverTs 为准，防并发覆盖
 *    5. 多房间隔离：每个 roomId 对应独立状态
 * ============================================================
 */
'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  pingTimeout:  10000,
  pingInterval: 5000
});

// 静态文件托管（把三个 HTML 放 ./public/ 即可）
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  多房间状态管理
// ============================================================

/** 全局房间 Map<roomId, RoomState> */
const rooms = new Map();

/** 创建新房间初始状态 */
function createRoomState(roomId) {
  return {
    roomId,
    teams:       [],   // [{id, name, members:[], score}]
    round:       1,
    buzzOpen:    false,
    buzzOpenTs:  0,    // 服务端开启抢答的精确时间戳（权威）
    buzzList:    [],   // [{teamId,teamName,playerName,serverTs,clientTs}]
    scoredRound: false,
    history:     [],   // [{round,winner,delta,time}]
    onlineTeams: [],   // 在线队伍名列表
    lastUpdate:  Date.now()
  };
}

/** 获取房间（createIfAbsent=true 时不存在则创建） */
function getRoom(roomId, createIfAbsent = false) {
  if (!rooms.has(roomId)) {
    if (!createIfAbsent) return null;
    rooms.set(roomId, createRoomState(roomId));
    console.log(`[Room] Created: ${roomId}`);
  }
  return rooms.get(roomId);
}

/** 广播房间状态给所有成员 */
function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.lastUpdate = Date.now();
  io.to(roomId).emit('sync_state', room);
}

/** 广播抢答第一名强提示 */
function broadcastWinnerAlert(roomId, teamName, reactionMs) {
  io.to(roomId).emit('buzz_winner_alert', { teamName, reactionMs });
  console.log(`[Buzz] Room ${roomId} Winner: ${teamName} | ${reactionMs}ms`);
}

/** 校验是否为 admin 并返回房间 */
function getAdminRoom(socket) {
  if (socket.data.role !== 'admin') {
    socket.emit('error_msg', { code: 'FORBIDDEN', msg: '无管理权限' });
    return null;
  }
  const room = rooms.get(socket.data.roomId);
  if (!room) {
    socket.emit('error_msg', { code: 'ROOM_NOT_FOUND', msg: '房间不存在' });
    return null;
  }
  return room;
}

// ============================================================
//  Socket.io 主逻辑
// ============================================================
io.on('connection', (socket) => {
  console.log(`[Connect] ${socket.id}`);

  // ── 加入房间 ────────────────────────────────────────────────
  // payload: { roomId, role:'admin'|'player'|'display', createRoom?:bool }
  socket.on('join_room', ({ roomId, role, createRoom }) => {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      socket.emit('error_msg', { code: 'INVALID_ROOM', msg: '房间号无效' });
      return;
    }
    const rid = roomId.trim().toUpperCase();

    // Admin 可创建新房间；Player/Display 只能加入已存在房间
    const isAdmin = (role === 'admin');
    const room = getRoom(rid, isAdmin && !!createRoom);

    if (!room) {
      socket.emit('error_msg', { code: 'ROOM_NOT_FOUND', msg: `房间 "${rid}" 不存在，请等待管理员先创建` });
      return;
    }

    socket.join(rid);
    socket.data.roomId = rid;
    socket.data.role   = role;

    console.log(`[Room] ${role} ${socket.id} => ${rid}`);

    // 立即同步当前状态给新连入者
    socket.emit('sync_state', room);
    socket.emit('join_room_ok', { roomId: rid });
  });

  // ── [Admin] 队伍管理 ────────────────────────────────────────
  // payload: { type:'add'|'edit'|'delete', team:{...} }
  socket.on('action_manage_team', ({ type, team }) => {
    const room = getAdminRoom(socket);
    if (!room) return;

    if (type === 'add') {
      if (room.teams.find(t => t.name === team.name)) {
        socket.emit('error_msg', { code: 'TEAM_EXISTS', msg: '队伍名已存在' }); return;
      }
      room.teams.push({ id: String(Date.now()), name: team.name, members: team.members || [], score: 0 });

    } else if (type === 'edit') {
      const t = room.teams.find(t => t.id === team.id);
      if (!t) return;
      if (room.teams.find(t2 => t2.name === team.name && t2.id !== team.id)) {
        socket.emit('error_msg', { code: 'TEAM_EXISTS', msg: '队伍名已存在' }); return;
      }
      t.name = team.name; t.members = team.members || [];

    } else if (type === 'delete') {
      room.teams    = room.teams.filter(t => t.id !== team.id);
      room.buzzList = room.buzzList.filter(b => b.teamId !== team.id);
    }

    broadcastState(room.roomId);
  });

  // ── [Admin] 开启抢答 ────────────────────────────────────────
  socket.on('action_open_buzz', () => {
    const room = getAdminRoom(socket);
    if (!room || room.buzzOpen) return;  // 防重复

    room.buzzOpen    = true;
    room.buzzOpenTs  = Date.now();  // 服务端权威时间戳
    room.buzzList    = [];
    room.scoredRound = false;

    console.log(`[Buzz] Room ${room.roomId} Round ${room.round} OPEN at ${room.buzzOpenTs}`);
    broadcastState(room.roomId);
  });

  // ── [Admin] 重置抢答 ────────────────────────────────────────
  socket.on('action_reset_buzz', () => {
    const room = getAdminRoom(socket);
    if (!room) return;
    room.buzzOpen = false; room.buzzOpenTs = 0;
    room.buzzList = []; room.scoredRound = false;
    broadcastState(room.roomId);
  });

  // ── [Admin] 判分（进入下一轮） ───────────────────────────────
  // payload: { delta: number }
  socket.on('action_score', ({ delta }) => {
    const room = getAdminRoom(socket);
    if (!room || !room.buzzList.length) return;

    const d      = Number(delta) || 0;
    const winner = room.buzzList[0];
    const team   = room.teams.find(t => t.id === winner.teamId);
    if (!team) return;

    if (d !== 0) {
      team.score += d;  // 允许负分，无下限
      room.history.unshift({
        round: room.round, winner: winner.teamName, delta: d,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
    }

    // 自动进入下一轮
    room.round++;
    room.buzzOpen = false; room.buzzOpenTs = 0;
    room.buzzList = []; room.scoredRound = true;

    console.log(`[Score] Room ${room.roomId} R${room.round-1} ${team.name} ${d>=0?'+':''}${d}`);
    broadcastState(room.roomId);
  });

  // ── [Admin] 直接调整任意队伍分数 ────────────────────────────
  // payload: { teamId, delta }
  socket.on('action_adjust_score', ({ teamId, delta }) => {
    const room = getAdminRoom(socket);
    if (!room) return;
    const team = room.teams.find(t => t.id === teamId);
    if (!team) return;
    team.score += Number(delta) || 0;
    broadcastState(room.roomId);
  });

  // ── [Admin] 清空历史 ────────────────────────────────────────
  socket.on('action_clear_history', () => {
    const room = getAdminRoom(socket);
    if (!room) return;
    room.history = [];
    broadcastState(room.roomId);
  });

  // ── [Player] 抢答核心 ────────────────────────────────────────
  /**
   * 防并发判定：
   *   - serverTs = Date.now()（服务端接收时间）作为排序权威
   *   - clientTs 仅用于展示（客户端感知的反应时长）
   *   - 同一 teamId 在同一轮只能进入一次 buzzList
   *
   * payload: { teamId, teamName, playerName, clientTs }
   */
  socket.on('action_buzz', ({ teamId, teamName, playerName, clientTs }) => {
    const serverTs = Date.now();  // ← 权威时间，立即记录
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // 抢答未开放
    if (!room.buzzOpen) {
      socket.emit('error_msg', { code: 'BUZZ_CLOSED', msg: '抢答未开放，本次无效' });
      return;
    }
    // 队伍本轮已抢答（防双击/网络重传）
    if (room.buzzList.find(b => b.teamId === teamId)) return;
    // 队伍需存在于房间
    if (!room.teams.find(t => t.id === teamId)) {
      socket.emit('error_msg', { code: 'TEAM_NOT_FOUND', msg: '队伍不在此房间' });
      return;
    }

    const isFirst = room.buzzList.length === 0;

    room.buzzList.push({
      teamId, teamName,
      playerName: playerName || '',
      serverTs,               // 排序依据
      clientTs: clientTs || serverTs  // 展示用
    });

    console.log(`[Buzz] ${roomId} R${room.round} #${room.buzzList.length} ${teamName}(${playerName}) serverTs=${serverTs}`);

    broadcastState(roomId);

    // 第一名：触发全端强提示
    if (isFirst) {
      const reactionMs = room.buzzOpenTs > 0 ? serverTs - room.buzzOpenTs : 0;
      broadcastWinnerAlert(roomId, teamName, reactionMs);
    }
  });

  // ── [Player] 在线状态 ────────────────────────────────────────
  // payload: { teamName, action:'join'|'leave' }
  socket.on('action_online', ({ teamName, action }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !teamName) return;
    if (action === 'join' && !room.onlineTeams.includes(teamName)) {
      room.onlineTeams.push(teamName);
      socket.data.teamName = teamName;  // 断线时使用
    } else if (action === 'leave') {
      room.onlineTeams = room.onlineTeams.filter(n => n !== teamName);
    }
    broadcastState(roomId);
  });

  // ── 断线处理 ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomId, role, teamName } = socket.data;
    console.log(`[Disconnect] ${role||'?'} ${socket.id} room=${roomId||'-'}`);
    if (roomId && role === 'player' && teamName) {
      const room = rooms.get(roomId);
      if (room) {
        room.onlineTeams = room.onlineTeams.filter(n => n !== teamName);
        broadcastState(roomId);
      }
    }
  });
});

// ============================================================
//  启动
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Quiz Master 已启动`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Admin  -> /Admin.html`);
  console.log(`   Player -> /Player.html`);
  console.log(`   Display-> /Display.html\n`);
});