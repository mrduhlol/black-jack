const socket = io();
const $ = (id) => document.getElementById(id);

// --- skribbl-style avatar picker ---
const FACES = ['🙂', '😎', '🤠', '🦊', '🐼', '🤖', '👽', '🔥'];
const COLORS = ['#ffd54f', '#ff8a80', '#80d8ff', '#b9f6ca', '#ea80fc', '#ffccbc'];
let avatar = { face: FACES[0], color: COLORS[0] };

function buildAvatarPicker() {
  const fr = $('faceRow');
  const cr = $('colorRow');
  FACES.forEach((f) => {
    const b = document.createElement('button');
    b.textContent = f;
    if (f === avatar.face) b.classList.add('sel');
    b.onclick = () => { avatar.face = f; [...fr.children].forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); renderAvatar(); };
    fr.appendChild(b);
  });
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.style.background = c;
    b.textContent = '●';
    if (c === avatar.color) b.classList.add('sel');
    b.onclick = () => { avatar.color = c; [...cr.children].forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); renderAvatar(); };
    cr.appendChild(b);
  });
  renderAvatar();
}
function renderAvatar() {
  const p = $('avatarPreview');
  p.textContent = avatar.face;
  p.style.background = avatar.color;
}
function myName() {
  return ($('nameInput').value || 'Player').slice(0, 14);
}

buildAvatarPicker();
// auto-fill invite code from ?XXXXXX like skribbl.io
const qs = new URLSearchParams(location.search);
if ([...qs.keys()][0]) $('codeInput').value = [...qs.keys()][0].toUpperCase();

$('playBtn').onclick = () => socket.emit('joinPublic', { name: myName(), avatar });
$('createBtn').onclick = () => socket.emit('createPrivate', { name: myName(), avatar });
$('joinBtn').onclick = () => socket.emit('joinPrivate', { code: $('codeInput').value.trim(), name: myName(), avatar });

socket.on('roomCreated', ({ id }) => {
  history.replaceState(null, '', `/?${id}`);
});
socket.on('joinError', (msg) => alert(msg));
