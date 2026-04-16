const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 托管存放 HTML 文件的 public 文件夹
app.use(express.static('public'));

// 服务器端的“中央状态”
let globalState = {
  teams: [],
  round: 1,
  buzzOpen: false,
  buzzList: [],
  scoredRound: false,
  history: [],
  onlineTeams: [],
  lastUpdate: Date.now()
};

// 监听客户端连接
io.on('connection', (socket) => {
  console.log('新用户连接:', socket.id);

  // 用户刚连上时，立刻把当前最新状态发给他
  socket.emit('sync_state', globalState);

  // 监听来自任何客户端的状态更新请求（比如管理员改分、队员抢答）
  socket.on('update_state', (newState) => {
    // 覆盖服务器状态
    globalState = { ...newState, lastUpdate: Date.now() };
    // 广播给【所有人】（包括发送者）更新画面
    io.emit('sync_state', globalState);
  });

  socket.on('disconnect', () => {
    console.log('用户断开:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 抢答服务器已启动! 访问地址: http://localhost:${PORT}`);
});