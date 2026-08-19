// MIGHTY WebSocket multiplayer server
// Node.js 18+
// npm install ws
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const rooms = new Map();

function code() {
  let s;
  do { s = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (rooms.has(s));
  return s;
}
function send(ws, obj){ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function listPlayers(room){
  return [...room.clients.values()].map(c=>({id:c.id,name:c.name,host:c.id===room.hostId,ai:false}));
}
function broadcast(room,obj){
  for(const c of room.clients.values()) send(c.ws,obj);
}
function cleanup(room){
  if(!room || room.clients.size) return;
  rooms.delete(room.code);
}

const httpServer=http.createServer((req,res)=>{
  if(req.url==="/health"){res.writeHead(200,{"content-type":"text/plain"});res.end("MIGHTY OK");return;}
  if(req.url==="/" || req.url==="/mighty-online.html"){
    const f=path.join(__dirname,"mighty-online.html");
    fs.readFile(f,(err,data)=>{
      if(err){res.writeHead(500);res.end("mighty-online.html not found");}
      else {res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(data);}
    });
    return;
  }
  res.writeHead(404,{"content-type":"text/plain"});res.end("Not found");
});
const wss=new WebSocket.Server({server:httpServer,path:"/ws"});

wss.on("connection",(ws)=>{
  let me=null, room=null;
  ws.on("message",(raw)=>{
    let m; try{m=JSON.parse(raw.toString())}catch(e){return;}
    if(m.type==="join"){
      const nickname=String(m.nickname||"플레이어").trim().slice(0,12)||"플레이어";
      let rcode=String(m.room||"").trim().toUpperCase();
      if(rcode && !rooms.has(rcode)){ send(ws,{type:"error",message:"존재하지 않는 방입니다."}); return; }
      if(!rcode){ rcode=code(); rooms.set(rcode,{code:rcode,clients:new Map(),hostId:null}); }
      room=rooms.get(rcode);
      if(room.clients.size>=5){send(ws,{type:"error",message:"방이 가득 찼습니다. (최대 5명)"});return;}
      const used=[...room.clients.keys()];
      let id=0; while(used.includes(id)) id++;
      me={id,name:nickname,ws};
      room.clients.set(id,me);
      if(room.hostId===null) room.hostId=id;
      send(ws,{type:"welcome",room:rcode,playerId:id,host:id===room.hostId,players:listPlayers(room)});
      broadcast(room,{type:"lobby",room:rcode,players:listPlayers(room),hostId:room.hostId});
      return;
    }
    if(!room||!me) return;
    if(m.type==="action"){
      const host=room.clients.get(room.hostId);
      if(host) send(host.ws,{type:"action",action:m.action,playerId:me.id});
      return;
    }
    if(m.type==="state" && me.id===room.hostId){
      // State is intentionally relayed by the server. The game client hides opponents' hands in its UI.
      // For a trusted private-room game this is sufficient; do not use this architecture for competitive anti-cheat play.
      broadcast(room,{type:"state",state:m.state});
      return;
    }
  });
  ws.on("close",()=>{
    if(!room||!me) return;
    room.clients.delete(me.id);
    if(room.hostId===me.id){
      // Current version closes the room rather than silently changing the authoritative game host.
      broadcast(room,{type:"error",message:"방장이 나가서 게임이 종료되었습니다."});
      for(const c of room.clients.values()) try{c.ws.close();}catch(e){}
      room.clients.clear();
      rooms.delete(room.code);
    }else{
      broadcast(room,{type:"lobby",room:room.code,players:listPlayers(room),hostId:room.hostId});
      cleanup(room);
    }
  });
});

httpServer.listen(PORT,()=>console.log(`MIGHTY WebSocket server listening on :${PORT}`));
