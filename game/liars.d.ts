// Type declarations for the pure Liar's Table engine (./liars.js).
// Dependency-free ES-module JavaScript, shared by the Worker/Durable Object.
export interface LiarCard {
  id: string;
  rank: string;
  suit: string;
}

export interface ChamberSlot {
  live: boolean;
  picked: boolean;
}

export const TABLE_RANKS: string[];
export const JOKER_RANK: string;
export const JOKER_SUIT: string;
export const SUITS: string[];
export const HAND_SIZE: number;
export const MAX_PLAY: number;
export function isJoker(card: LiarCard): boolean;
export function buildDeck(): LiarCard[];
export function shuffle(cards: LiarCard[]): LiarCard[];
export function dealHands(playerIds: string[], handSize?: number): { hands: Record<string, LiarCard[]>; leftover: LiarCard[] };
export function randomTableRank(): string;
export function judgeChallenge(playedCards: LiarCard[], tableRank: string): boolean;
export function buildChamber(chambers: number, live: number): ChamberSlot[];
export function plural(n: number, word: string): string;
