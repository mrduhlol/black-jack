// Cool characters from the internet — DiceBear avatar API (free, no key).
// https://www.dicebear.com/ — pick a style, seed = unique face per player.
// Blackjack = neon casino crew. Liar's Table = shady bar patrons (own styles + palette).
const AVATAR_STYLES = [
  { id: 'adventurer', label: 'Adventurer' },
  { id: 'bottts', label: 'Robot' },
  { id: 'lorelei', label: 'Lorelei' },
  { id: 'micah', label: 'Micah' },
  { id: 'personas', label: 'Persona' },
  { id: 'croodles', label: 'Croodle' },
];

const AVATAR_BGS = ['ffd54f', 'ff8a80', '80d8ff', 'b9f6ca', 'ea80fc', 'ffccbc', '1e2a32', '5c6bc0'];

// Liar's Table cast — deliberately different silhouettes from the blackjack crew.
const AVATAR_STYLES_LIARS = [
  { id: 'adventurer-neutral', label: 'Outlaw' },
  { id: 'lorelei-neutral', label: 'Madame' },
  { id: 'notionists', label: 'Drifter' },
  { id: 'open-peeps', label: 'Bandit' },
  { id: 'thumbs', label: 'Ghost' },
  { id: 'fun-emoji', label: 'Joker' },
];

const AVATAR_BGS_LIARS = ['3a2417', '5a3a22', '8e2f20', 'c9a35c', '241a10', '1c1008', '6b4c2a', 'ece3d0'];

function avatarStylesFor(mode) {
  return mode === 'liars' ? AVATAR_STYLES_LIARS : AVATAR_STYLES;
}

function avatarBgsFor(mode) {
  return mode === 'liars' ? AVATAR_BGS_LIARS : AVATAR_BGS;
}

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
