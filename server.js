// 마이티(Mighty) 온라인 방 릴레이 서버
// -----------------------------------------------------------------------------
// 이 서버는 게임 규칙을 전혀 모릅니다. 그냥 같은 방(room)에 들어온 클라이언트끼리
// 메시지를 그대로 전달(relay)만 하는 역할입니다. 실제 카드 게임 로직은 방장(host)의
// 브라우저가 전부 계산하고, 그 결과를 이 서버를 통해 나머지 사람들에게 뿌립니다.
//
// 배포 방법 (Render):
//   1) 이 폴더(mighty-server) 전체를 GitHub 저장소에 올립니다.
//   2) Render 대시보드 -> New -> Web Service -> 해당 저장소 선택
//   3) Build Command: npm install / Start Command: npm start (Render가 자동 인식)
//   4) 배포가 끝나면 https://<앱이름>.onrender.com 주소가 생기고,
//      마이티 게임 HTML 파일 안의 ONLINE_SERVER_URL 을
//      wss://<앱이름>.onrender.com 으로 바꿔주면 됩니다.
// -----------------------------------------------------------------------------

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// room code -> { players: [{id, ws, name, host}], nextId }
const rooms = new Map();

function makeRoomCode() {
  // 숫자로만 구성된 6자리 방 코드 (예: 482913)
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

// 플레이어별 재접속 토큰 (다른 화면에 잠깐 나갔다 와도 같은 자리로 돌아올 수 있게 해줌)
function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// 연결이 끊긴 뒤 완전히 방을 나간 것으로 처리하기까지 기다려주는 유예 시간
const RECONNECT_GRACE_MS = 45000;

function publicPlayers(room) {
  return room.players.map((p) => ({ id: p.id, name: p.name, host: p.host, connected: p.connected !== false }));
}

function broadcastLobby(room) {
  const payload = JSON.stringify({ type: "lobby", players: publicPlayers(room) });
  for (const p of room.players) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  // 헬스체크용 (Render가 주기적으로 접속을 확인합니다)
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("mighty online relay server is running");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let joined = null; // {roomCode, playerId}

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (m.type === "join") {
      const nickname = String(m.nickname || "플레이어").slice(0, 12) || "플레이어";
      // 방 코드는 숫자만 허용한다 (참여자가 잘못된 문자를 섞어 입력해도 무시)
      let roomCode = String(m.room || "").replace(/\D/g, "").trim();
      const token = typeof m.token === "string" && m.token ? m.token : null;

      // 재접속: 토큰을 가지고 있고, 그 방에 같은 토큰을 쓰던(연결이 끊겼던) 자리가 남아있으면
      // 새 자리를 만들지 않고 원래 자리를 그대로 이어받는다.
      if (roomCode && token && rooms.has(roomCode)) {
        const existingRoom = rooms.get(roomCode);
        const existingPlayer = existingRoom.players.find((p) => p.token === token);
        if (existingPlayer) {
          if (existingPlayer.leaveTimer) {
            clearTimeout(existingPlayer.leaveTimer);
            existingPlayer.leaveTimer = null;
          }
          existingPlayer.ws = ws;
          existingPlayer.connected = true;
          if (nickname) existingPlayer.name = nickname;
          joined = { roomCode, playerId: existingPlayer.id };

          send(ws, {
            type: "welcome",
            playerId: existingPlayer.id,
            host: existingPlayer.host,
            room: roomCode,
            token: existingPlayer.token,
            players: publicPlayers(existingRoom),
            resumed: true,
          });
          broadcastLobby(existingRoom);
          for (const p of existingRoom.players) {
            if (p.id !== existingPlayer.id) send(p.ws, { type: "peer_back", name: existingPlayer.name });
          }
          return;
        }
        // 토큰과 일치하는 자리가 없다면(유예 시간이 지나 이미 완전히 나간 상태) 아래의 일반 입장 로직으로 진행한다.
      }

      let room;
      if (roomCode) {
        // 참여자가 방 코드를 입력한 경우: 반드시 이미 존재하는 방이어야만 입장할 수 있다.
        // (예전에는 존재하지 않는 코드를 입력하면 그 코드로 새 방을 만들어버렸는데,
        //  그러면 오타를 낸 참여자가 엉뚱한 유령 방의 "방장"이 되어버리고, 자신은 게임에
        //  못 들어갔다고 착각하거나 다른 방과 뒤섞일 위험이 있었다. 존재하지 않는 코드는
        //  그냥 에러로 돌려주고, 기존 방(원래 방장이 만든 방)에는 아무 영향도 주지 않는다.)
        if (!rooms.has(roomCode)) {
          send(ws, { type: "error", message: "존재하지 않는 방 코드입니다. 코드를 다시 확인해주세요." });
          return;
        }
        room = rooms.get(roomCode);
        const activeCount = room.players.filter((p) => p.connected !== false).length;
        if (activeCount >= 5) {
          send(ws, { type: "error", message: "방이 가득 찼습니다 (최대 5명)." });
          return;
        }
      } else {
        // 방 코드를 비워두면 새 방을 만든다 (이때만 방장이 된다)
        roomCode = makeRoomCode();
        room = { code: roomCode, players: [], nextId: 0 };
        rooms.set(roomCode, room);
      }

      const isHost = room.players.length === 0;
      const playerId = room.nextId++;
      const playerObj = {
        id: playerId,
        ws,
        name: nickname,
        host: isHost,
        token: token || makeToken(),
        connected: true,
        leaveTimer: null,
      };
      room.players.push(playerObj);
      joined = { roomCode, playerId };

      send(ws, {
        type: "welcome",
        playerId,
        host: isHost,
        room: roomCode,
        token: playerObj.token,
        players: publicPlayers(room),
      });
      broadcastLobby(room);
      return;
    }

    if (!joined) return; // join 이전에는 아무 것도 처리하지 않음
    const room = rooms.get(joined.roomCode);
    if (!room) return;

    if (m.type === "action") {
      // guest -> host 로만 전달 (host의 ws에게)
      const host = room.players.find((p) => p.host);
      if (host) send(host.ws, { type: "action", action: m.action, playerId: joined.playerId });
      return;
    }

    if (m.type === "state" || m.type === "timer") {
      // host -> 방의 모든 사람에게 그대로 전달 (host 자신 제외)
      const sender = room.players.find((p) => p.id === joined.playerId);
      if (!sender || !sender.host) return; // host만 상태를 뿌릴 수 있다
      for (const p of room.players) {
        if (p.id !== joined.playerId) send(p.ws, m);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (!joined) return;
    const room = rooms.get(joined.roomCode);
    if (!room) return;

    const player = room.players.find((p) => p.id === joined.playerId);
    if (!player) return;
    // 이미 같은 자리에 재접속(새 ws)이 붙어있다면, 지금 닫히는 건 옛날 연결이므로 무시한다.
    if (player.ws !== ws) return;

    player.connected = false;
    broadcastLobby(room);
    for (const p of room.players) {
      if (p.id !== player.id) send(p.ws, { type: "peer_away", name: player.name });
    }

    // 유예 시간 안에 재접속하지 않으면 그때 완전히 방을 나간 것으로 처리한다.
    player.leaveTimer = setTimeout(() => {
      const idx = room.players.findIndex((p) => p.id === player.id);
      if (idx === -1) return;
      const leaving = room.players[idx];
      if (leaving.connected) return; // 그 사이에 재접속했다면 제거하지 않는다
      room.players.splice(idx, 1);

      if (room.players.length === 0) {
        rooms.delete(joined.roomCode);
        return;
      }

      // 방장이 끝내 돌아오지 않았다면 남은 사람 중 가장 먼저 들어온 사람을 새 방장으로 승격
      if (leaving.host) {
        room.players[0].host = true;
        send(room.players[0].ws, {
          type: "welcome",
          playerId: room.players[0].id,
          host: true,
          room: room.code,
          token: room.players[0].token,
          players: publicPlayers(room),
        });
      }

      for (const p of room.players) {
        send(p.ws, { type: "peer_left", name: leaving.name });
      }
      broadcastLobby(room);
    }, RECONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`mighty online relay server listening on :${PORT}`);
});
