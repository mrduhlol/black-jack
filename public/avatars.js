// Cool characters from the internet — DiceBear avatar API (free, no key).
// https://www.dicebear.com/ — pick a style, seed = unique face per player.
const AVATAR_STYLES = [
  { id: 'adventurer', label: 'Adventurer' },
  { id: 'bottts', label: 'Robot' },
  { id: 'lorelei', label: 'Lorelei' },
  { id: 'micah', label: 'Micah' },
  { id: 'personas', label: 'Persona' },
  { id: 'croodles', label: 'Croodle' },
];

const AVATAR_BGS = ['ffd54f', 'ff8a80', '80d8ff', 'b9f6ca', 'ea80fc', 'ffccbc', '1e2a32', '5c6bc0'];

function avatarUrl(a) {
  if (!a) return '';
  // back-compat: old emoji avatars {face, color}
  if (a.face) return '';
  const style = a.style || 'adventurer';
  const seed = encodeURIComponent(a.seed || 'Player');
  const bg = (a.bg || 'ffd54f').replace('#', '');
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${seed}&backgroundColor=${bg}`;
}

function randomSeed() {
  return Math.random().toString(36).slice(2, 9);
}
