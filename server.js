const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-b234f5da203f4eb592ed460f2b03bdf9';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Chatroom WebSocket Server OK');
});

const wss = new WebSocketServer({ server });

// 房间存储
const rooms = new Map(); // roomId -> { users: Map<ws, {id, username, lang}> }

function genId(len = 6) {
  return crypto.randomInt(100000, 999999).toString();
}

function genUsername() {
  const adj = ['快乐的', '可爱的', '聪明的', '帅气的', '漂亮的', '温柔的', '活泼的', '安静的'];
  const noun = ['小猫', '小狗', '小兔', '小鸟', '小鱼', '小熊', '小鹿', '小猴'];
  return adj[Math.floor(Math.random() * adj.length)] + noun[Math.floor(Math.random() * noun.length)];
}

function getUsers(room) {
  const users = [];
  for (const [ws, info] of room.users) {
    users.push({ id: info.id, username: info.username, lang: info.lang });
  }
  return users;
}

function broadcast(room, msg, exclude = null) {
  const data = JSON.stringify(msg);
  for (const [ws] of room.users) {
    if (ws !== exclude && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

async function translate(text, sourceLang, targetLang) {
  const langMap = { zh: '简体中文', vi: '越南语' };
  const systemPrompt = '你是一个资深中越翻译专家，精通中越两国语言文化。翻译准确自然，只输出翻译结果。';
  const userPrompt = `请将以下${langMap[sourceLang]}翻译成${langMap[targetLang]}，只输出翻译结果：\n${text}`;

  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 1000
      })
    });
    if (!resp.ok) return text;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || text;
  } catch (e) {
    console.error('Translation error:', e.message);
    return text;
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let userInfo = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        const roomId = genId();
        const userId = crypto.randomUUID();
        const username = msg.username?.trim() || genUsername();
        const lang = msg.lang || 'zh';

        userInfo = { id: userId, username, lang };
        const room = { users: new Map() };
        room.users.set(ws, userInfo);
        rooms.set(roomId, room);
        currentRoom = roomId;

        send(ws, {
          type: 'room-created',
          roomId, userId, username,
          users: getUsers(room)
        });
        console.log(`Room ${roomId} created by ${username}`);
        break;
      }

      case 'join-room': {
        const roomId = msg.roomId;
        const room = rooms.get(roomId);
        if (!room) {
          send(ws, { type: 'error', message: '房间不存在' });
          return;
        }

        const userId = crypto.randomUUID();
        const username = msg.username?.trim() || genUsername();
        const lang = msg.lang || 'zh';

        userInfo = { id: userId, username, lang };
        room.users.set(ws, userInfo);
        currentRoom = roomId;

        send(ws, {
          type: 'room-joined',
          roomId, userId, username,
          users: getUsers(room)
        });

        broadcast(room, {
          type: 'user-joined',
          username,
          users: getUsers(room)
        }, ws);

        console.log(`${username} joined room ${roomId}`);
        break;
      }

      case 'message': {
        if (!currentRoom || !userInfo) return;
        const room = rooms.get(currentRoom);
        if (!room) return;

        const text = msg.text;
        if (!text?.trim()) return;

        // 确定翻译方向
        const hasChinese = /[\u4e00-\u9fff]/.test(text);
        const sourceLang = hasChinese ? 'zh' : 'vi';
        const targetLang = sourceLang === 'zh' ? 'vi' : 'zh';

        // 异步翻译
        const translated = await translate(text, sourceLang, targetLang);

        const msgData = {
          type: 'message',
          userId: userInfo.id,
          username: userInfo.username,
          original: text,
          translated,
          sourceLang,
          time: new Date().toISOString()
        };

        // 发给发送者
        send(ws, msgData);

        // 广播给房间其他人
        broadcast(room, msgData, ws);
        break;
      }

      case 'update-lang': {
        if (userInfo) userInfo.lang = msg.lang || 'zh';
        if (currentRoom) {
          const room = rooms.get(currentRoom);
          if (room) {
            room.users.set(ws, userInfo);
            broadcast(room, { type: 'user-joined', username: userInfo.username, users: getUsers(room) });
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && userInfo) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.users.delete(ws);
        if (room.users.size === 0) {
          rooms.delete(currentRoom);
          console.log(`Room ${currentRoom} deleted (empty)`);
        } else {
          broadcast(room, {
            type: 'user-left',
            username: userInfo.username,
            users: getUsers(room)
          });
        }
      }
    }
  });
});

// 心跳：定期清理断开的连接
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Chatroom server running on port ${PORT}`);
});
