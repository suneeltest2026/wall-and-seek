const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------- CONSTANTS ----------
const ROOM_HALF = 20; // room floor spans -20..20 on x and z
const DEFAULT_SETTINGS = {
  seekerCount: 1,
  wallUses: 3,
  wallShieldSec: 8,
  calloutUses: 2,
  hideSec: 20,   // time hiders get to pick a spot before seeking starts
  seekSec: 600,  // overall seek time limit
  graceSec: 8
};
const CATCH_RADIUS = 2.2;
const MAPS = [
  { id:'warehouse', name:'Warehouse' },
  { id:'ruins', name:'Ancient Ruins' },
  { id:'arena', name:'Open Arena' }
];
const MAP_IDS = MAPS.map(m=>m.id);

// ---------- ROOM STORE ----------
// rooms: code -> { code, phase, phaseStartedAt, settings, players:{name:{...}}, sockets:Map(name->ws), log:[], winner, winnerType }
const rooms = new Map();

function now(){ return Date.now(); }
function normCode(c){ return String(c||'').trim().toUpperCase(); }
function genCode(){
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c='';
  for(let i=0;i<4;i++) c += letters[Math.floor(Math.random()*letters.length)];
  return c;
}
function log(room, text){
  room.log = room.log || [];
  room.log.push({t: now(), text});
  if(room.log.length>40) room.log.shift();
}
function activeEntries(room){
  return Object.entries(room.players).filter(([n,p])=>!p.out);
}
function publicState(room){
  // strip nothing sensitive here, but omit large per-frame fields from the "state" message;
  // positions are sent separately via the lighter 'positions' message.
  const players = {};
  for(const [n,p] of Object.entries(room.players)){
    players[n] = {
      isHost: p.isHost, role: p.role, out: p.out,
      wallUsesLeft: p.wallUsesLeft, calloutsLeft: p.calloutsLeft,
      wallUntil: p.wallUntil, graceUntil: p.graceUntil
    };
  }
  return {
    code: room.code, phase: room.phase, phaseStartedAt: room.phaseStartedAt,
    settings: room.settings, players, log: room.log,
    winner: room.winner, winnerType: room.winnerType,
    maps: MAPS, mapVotes: room.mapVotes || {}, mapId: room.mapId
  };
}
function broadcastState(room){
  const msg = JSON.stringify({type:'state', room: publicState(room)});
  for(const ws of room.sockets.values()){
    if(ws.readyState===WebSocket.OPEN) ws.send(msg);
  }
}
function broadcastPositions(room){
  const positions = {};
  for(const [n,p] of Object.entries(room.players)){
    positions[n] = { x:p.x||0, z:p.z||0, rotY:p.rotY||0, jumpY:p.jumpY||0, role:p.role, out:p.out, walled: now()<p.wallUntil };
  }
  const msg = JSON.stringify({type:'positions', positions});
  for(const ws of room.sockets.values()){
    if(ws.readyState===WebSocket.OPEN) ws.send(msg);
  }
}
function sendError(ws, message){
  if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:'error', message}));
}
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

function checkWinConditions(room){
  if(room.phase!=='seeking') return false;
  const active = activeEntries(room);
  const hiders = active.filter(([n,p])=>p.role==='hider');
  const elapsed = now() - room.phaseStartedAt;
  if(active.length<=1){
    room.phase='ended';
    room.winner = active.length===1 ? active[0][0] : null;
    room.winnerType = 'lastStanding';
    log(room, active.length===1 ? (active[0][0]+' is the last one standing!') : 'Game over.');
    return true;
  }
  if(hiders.length===0){
    room.phase='ended'; room.winnerType='seekers';
    log(room, 'All hiders caught! Seekers win!');
    return true;
  }
  if(elapsed >= room.settings.seekSec*1000){
    room.phase='ended';
    room.winnerType = hiders.length>0 ? 'hiders' : 'seekers';
    log(room, 'Time is up! ' + (hiders.length>0 ? 'Hiders win!' : 'Seekers win!'));
    return true;
  }
  return false;
}

// ---------- GAME LOOPS ----------
setInterval(()=>{
  for(const room of rooms.values()){
    let changed = false;
    const t = now();
    if(room.phase==='hiding' && room.phaseStartedAt && (t-room.phaseStartedAt) >= room.settings.hideSec*1000){
      room.phase='seeking';
      room.phaseStartedAt = t;
      log(room, 'Seeking has begun! Seekers are on the move.');
      changed = true;
    } else if(room.phase==='seeking'){
      changed = checkWinConditions(room) || changed;
    }
    if(changed) broadcastState(room);
  }
}, 300);

setInterval(()=>{
  for(const room of rooms.values()){
    if(room.sockets.size>0 && (room.phase==='hiding' || room.phase==='seeking')){
      broadcastPositions(room);
    }
  }
}, 90);

// clean up empty/stale rooms
setInterval(()=>{
  const cutoff = now() - 6*60*60*1000;
  for(const [code, room] of rooms){
    if(room.sockets.size===0 && (room.lastActivity||0) < cutoff) rooms.delete(code);
  }
}, 30*60*1000);

// ---------- MESSAGE HANDLERS ----------
function handleCreateRoom(ws, msg){
  const name = String(msg.name||'').trim().slice(0,16);
  if(!name) return sendError(ws, 'Enter a name.');
  const code = genCode();
  const room = {
    code, phase:'lobby', phaseStartedAt:null,
    settings: {...DEFAULT_SETTINGS},
    players: { [name]: newPlayer(true) },
    sockets: new Map([[name, ws]]),
    log: [], winner:null, winnerType:null, lastActivity: now(),
    mapVotes: {}, mapId: MAP_IDS[0]
  };
  rooms.set(code, room);
  ws.playerName = name; ws.roomCode = code;
  log(room, name+' created the room.');
  broadcastState(room);
}
function newPlayer(isHost){
  return {
    isHost, role:'unassigned', out:false,
    x:0, z:0, rotY:0,
    wallUsesLeft:0, calloutsLeft:0, wallUntil:0, graceUntil:0
  };
}
function handleJoinRoom(ws, msg){
  const name = String(msg.name||'').trim().slice(0,16);
  const code = normCode(msg.code);
  if(!name) return sendError(ws, 'Enter a name.');
  const room = rooms.get(code);
  if(!room) return sendError(ws, 'No room found with that code.');
  if(!room.players[name]){
    if(room.phase!=='lobby') return sendError(ws, 'That game has already started.');
    room.players[name] = newPlayer(false);
    log(room, name+' joined.');
  }
  room.sockets.set(name, ws);
  ws.playerName = name; ws.roomCode = code;
  room.lastActivity = now();
  broadcastState(room);
}
function getRoomFor(ws){
  if(!ws.roomCode) return null;
  return rooms.get(ws.roomCode) || null;
}
function handleUpdateSetting(ws, msg){
  const room = getRoomFor(ws); if(!room) return;
  const p = room.players[ws.playerName];
  if(!p || !p.isHost) return;
  const allowed = ['seekerCount','wallUses','wallShieldSec','calloutUses','hideSec','seekSec','graceSec'];
  if(!allowed.includes(msg.key)) return;
  const val = parseInt(msg.value);
  if(Number.isFinite(val)) room.settings[msg.key] = val;
  broadcastState(room);
}
function handleVoteMap(ws, msg){
  const room = getRoomFor(ws); if(!room) return;
  if(room.phase!=='lobby') return;
  const p = room.players[ws.playerName]; if(!p) return;
  const mapId = String(msg.mapId||'');
  if(!MAP_IDS.includes(mapId)) return;
  room.mapVotes = room.mapVotes || {};
  room.mapVotes[ws.playerName] = mapId;
  broadcastState(room);
}
function pickWinningMap(room){
  const tally = {};
  MAP_IDS.forEach(id=>tally[id]=0);
  Object.values(room.mapVotes||{}).forEach(id=>{ if(tally[id]!==undefined) tally[id]++; });
  let best=-1, winners=[];
  for(const id of MAP_IDS){
    const v = tally[id];
    if(v>best){ best=v; winners=[id]; }
    else if(v===best) winners.push(id);
  }
  return winners[Math.floor(Math.random()*winners.length)];
}
function handleStartGame(ws){
  const room = getRoomFor(ws); if(!room) return;
  const me = room.players[ws.playerName];
  if(!me || !me.isHost) return;
  const names = Object.keys(room.players);
  if(names.length<2) return sendError(ws, 'Need at least 2 players to start.');
  room.mapId = pickWinningMap(room);
  const seekerCount = Math.min(room.settings.seekerCount, names.length-1);
  const shuffled = [...names].sort(()=>Math.random()-0.5);
  const seekers = new Set(shuffled.slice(0, seekerCount));
  for(const n of names){
    const p = room.players[n];
    p.out = false;
    p.x = (Math.random()-0.5)*ROOM_HALF; p.z = (Math.random()-0.5)*ROOM_HALF;
    if(seekers.has(n)){
      p.role='seeker'; p.wallUsesLeft=0; p.calloutsLeft=0; p.wallUntil=0; p.graceUntil=0;
    } else {
      p.role='hider'; p.wallUsesLeft=room.settings.wallUses; p.calloutsLeft=room.settings.calloutUses;
      p.wallUntil=0; p.graceUntil=0;
    }
  }
  room.phase='hiding';
  room.phaseStartedAt = now();
  room.winner=null; room.winnerType=null; room.log=[];
  const mapName = (MAPS.find(m=>m.id===room.mapId)||{}).name || room.mapId;
  log(room, 'Round started on '+mapName+'. Hiders, find a spot!');
  broadcastState(room);
  broadcastPositions(room);
}
function handleMove(ws, msg){
  const room = getRoomFor(ws); if(!room) return;
  const p = room.players[ws.playerName]; if(!p || p.out) return;
  if(room.phase==='hiding' && p.role!=='hider') return; // seekers can't move/peek during hiding
  if(room.phase!=='hiding' && room.phase!=='seeking') return;
  if(now() < p.wallUntil) return; // frozen while a wall
  const x = Number(msg.x), z = Number(msg.z), rotY = Number(msg.rotY), jumpY = Number(msg.jumpY);
  if(!Number.isFinite(x) || !Number.isFinite(z)) return;
  p.x = clamp(x, -ROOM_HALF, ROOM_HALF);
  p.z = clamp(z, -ROOM_HALF, ROOM_HALF);
  p.rotY = Number.isFinite(rotY) ? rotY : p.rotY;
  p.jumpY = Number.isFinite(jumpY) ? clamp(jumpY, 0, 6) : 0;
  room.lastActivity = now();
}
function handleBecomeWall(ws){
  const room = getRoomFor(ws); if(!room) return;
  const p = room.players[ws.playerName]; if(!p) return;
  if(p.role!=='hider' || p.out || room.phase!=='seeking') return;
  const t = now();
  if(p.wallUsesLeft<=0 || t < p.wallUntil) return;
  p.wallUsesLeft -= 1;
  p.wallUntil = t + room.settings.wallShieldSec*1000;
  log(room, ws.playerName+' became a wall!');
  broadcastState(room);
}
function handleCatch(ws, msg){
  const room = getRoomFor(ws); if(!room) return;
  const seeker = room.players[ws.playerName];
  const target = room.players[msg.target];
  if(!seeker || !target || room.phase!=='seeking') return;
  if(seeker.role!=='seeker' || seeker.out) return;
  if(target.role!=='hider' || target.out) return;
  const dx = seeker.x-target.x, dz = seeker.z-target.z;
  if(Math.sqrt(dx*dx+dz*dz) > CATCH_RADIUS) return sendError(ws, 'Get closer to catch them!');
  const t = now();
  if(t < target.wallUntil){
    log(room, msg.target+' was shielded by the wall — catch failed!');
    broadcastState(room); return;
  }
  if(t < target.graceUntil){
    log(room, msg.target+' was still in the grace period — catch failed!');
    broadcastState(room); return;
  }
  if(target.calloutsLeft>0){
    target.calloutsLeft -= 1;
    target.graceUntil = t + 4000;
    log(room, msg.target+' wriggled free! ('+target.calloutsLeft+' call-outs left)');
  } else {
    target.out = true;
    log(room, msg.target+' was caught and is OUT!');
  }
  const ended = checkWinConditions(room);
  broadcastState(room);
  if(ended) broadcastPositions(room);
}
function handleCallOut(ws, msg){
  const room = getRoomFor(ws); if(!room) return;
  const hider = room.players[ws.playerName];
  const target = room.players[msg.target];
  if(!hider || !target || room.phase!=='seeking') return;
  if(hider.role!=='hider' || hider.out) return;
  if(!hider.calloutsLeft || hider.calloutsLeft<=0) return;
  if(target.role!=='seeker' || target.out) return;
  const dx = hider.x-target.x, dz = hider.z-target.z;
  if(Math.sqrt(dx*dx+dz*dz) > CATCH_RADIUS) return sendError(ws, 'Get closer to call them out!');
  const t = now();
  hider.calloutsLeft -= 1;
  target.role='hider'; target.wallUsesLeft=room.settings.wallUses; target.calloutsLeft=room.settings.calloutUses;
  target.wallUntil=0; target.graceUntil = t + room.settings.graceSec*1000;
  hider.role='seeker'; hider.wallUsesLeft=0; hider.calloutsLeft=0; hider.wallUntil=0; hider.graceUntil=0;
  log(room, ws.playerName+' spotted '+msg.target+'! Roles swapped.');
  broadcastState(room);
}
function handlePlayAgain(ws){
  const room = getRoomFor(ws); if(!room) return;
  const me = room.players[ws.playerName];
  if(!me || !me.isHost) return;
  room.phase='lobby'; room.winner=null; room.winnerType=null; room.phaseStartedAt=null;
  room.mapVotes = {};
  for(const n in room.players){
    room.players[n].role='unassigned'; room.players[n].out=false;
    room.players[n].wallUntil=0; room.players[n].graceUntil=0;
  }
  log(room, 'Back to the lobby for another round.');
  broadcastState(room);
}
function handleLeave(ws){
  const room = getRoomFor(ws); if(!room) return;
  room.sockets.delete(ws.playerName);
  ws.roomCode = null; ws.playerName = null;
}

wss.on('connection', (ws)=>{
  ws.on('message', (raw)=>{
    let msg;
    try{ msg = JSON.parse(raw); }catch(e){ return; }
    switch(msg.type){
      case 'createRoom': return handleCreateRoom(ws, msg);
      case 'joinRoom': return handleJoinRoom(ws, msg);
      case 'updateSetting': return handleUpdateSetting(ws, msg);
      case 'startGame': return handleStartGame(ws);
      case 'voteMap': return handleVoteMap(ws, msg);
      case 'move': return handleMove(ws, msg);
      case 'becomeWall': return handleBecomeWall(ws);
      case 'catch': return handleCatch(ws, msg);
      case 'callOut': return handleCallOut(ws, msg);
      case 'playAgain': return handlePlayAgain(ws);
      case 'leaveRoom': return handleLeave(ws);
    }
  });
  ws.on('close', ()=>{
    const room = getRoomFor(ws);
    if(room && ws.playerName){
      room.sockets.delete(ws.playerName);
    }
  });
});

app.get('/api/health', (req,res)=>res.json({ok:true, rooms: rooms.size}));

server.listen(PORT, ()=>{
  console.log('Wall & Seek 3D server running on port '+PORT);
});
