const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store. Fine for a casual party game — one Render instance,
// no persistence needed between deploys.
const rooms = new Map();

function normCode(code) {
  return String(code || '').trim().toUpperCase();
}

app.get('/api/room/:code', (req, res) => {
  const code = normCode(req.params.code);
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'not found' });
  res.json(room);
});

app.post('/api/room/:code', (req, res) => {
  const code = normCode(req.params.code);
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid room payload' });
  }
  body.code = code;
  body.updatedAt = Date.now();
  rooms.set(code, body);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// Clean up rooms that haven't been touched in 6 hours so memory doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if ((room.updatedAt || 0) < cutoff) rooms.delete(code);
  }
}, 30 * 60 * 1000);

app.listen(PORT, () => {
  console.log('Wall & Seek server running on port ' + PORT);
});
