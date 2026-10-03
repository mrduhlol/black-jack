// Type declarations for the pure Blackjack engine (./engine.js).
// The implementation stays dependency-free ES-module JavaScript so it runs
// unchanged in the Cloudflare Worker/Durable Object and in the browser.
export interface EngineCard {
  rank: string;
  suit: string;
}

export interface HandValue {
  total: number;
  soft: boolean;
  bust: boolean;
}

export interface SettleResult {
  outcome: string;
  payout: number;
}

export function cardValue(rank: string): number;
export function handValue(cards: EngineCard[]): HandValue;
export function createShoe(numDecks?: number): EngineCard[];
export function isBlackjack(cards: EngineCard[]): boolean;
export function dealerShouldHit(cards: EngineCard[], hitSoft17?: boolean): boolean;
export function bustChance(cards: EngineCard[]): number;
export function coachHint(playerCards: EngineCard[], dealerUp: EngineCard): string;
export function settleBet(
  playerCards: EngineCard[],
  dealerCards: EngineCard[],
  bet: number,
  opts?: { blackjackPays?: string },
): SettleResult;
export const RANKS: string[];
export const SUITS: string[];
