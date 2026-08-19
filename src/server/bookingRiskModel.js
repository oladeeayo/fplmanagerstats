// src/server/bookingRiskModel.js
// Booking risk model — predicts yellow/red card probability

// Historical booking rates by position (per 90 mins)
const BASE_YELLOW_RATE = {
  GKP: 0.06, DEF: 0.14, MID: 0.12, FWD: 0.09,
};

const BASE_RED_RATE = {
  GKP: 0.003, DEF: 0.008, MID: 0.005, FWD: 0.004,
};

// FPL card points
const YELLOW_CARD_PTS = -1;
const RED_CARD_PTS = -3;

// Calculate booking risk for a player
function calculateBookingRisk(player, options = {}) {
  const position = player.position || 'MID';
  const minutes = Number(player.minutes || 0);
  const yellowCards = Number(player.yellow_cards || 0);
  const redCards = Number(player.red_cards || 0);
  const xMins = Number(player.xMins || 75);
  const minutesShare = xMins / 90;

  // Base rate from position
  const baseYellow = BASE_YELLOW_RATE[position] || 0.12;
  const baseRed = BASE_RED_RATE[position] || 0.005;

  // Adjust based on historical card rate
  let yellowRate = baseYellow;
  let redRate = baseRed;

  if (minutes > 0) {
    const historicalYellowPer90 = (yellowCards * 90) / minutes;
    const historicalRedPer90 = (redCards * 90) / minutes;

    // Shrink toward base rate (sample size adjustment)
    const sampleWeight = minutes / (minutes + 900);
    yellowRate = (historicalYellowPer90 * sampleWeight) + (baseYellow * (1 - sampleWeight));
    redRate = (historicalRedPer90 * sampleWeight) + (baseRed * (1 - sampleWeight));
  }

  // Adjust for playing style (aggressive teams have higher card rates)
  // This could be opponent-adjusted in the future
  const teamModifier = options.aggressiveTeam ? 1.15 : 1.0;

  yellowRate *= teamModifier;
  redRate *= teamModifier;

  // Expected card points per match
  const expectedYellowPoints = yellowRate * minutesShare * YELLOW_CARD_PTS;
  const expectedRedPoints = redRate * minutesShare * RED_CARD_PTS;
  const totalCardPoints = expectedYellowPoints + expectedRedPoints;

  // Risk level
  const totalCardRate = yellowRate + redRate * 3; // weighted by severity
  const riskLevel = totalCardRate > 0.2 ? 'high' : totalCardRate > 0.12 ? 'medium' : 'low';

  return {
    yellowRate: Math.round(yellowRate * 1000) / 1000,
    redRate: Math.round(redRate * 1000) / 1000,
    expectedCardPoints: Math.round(totalCardPoints * 100) / 100,
    riskLevel,
    yellowCards,
    redCards,
    minutes,
  };
}

module.exports = {
  calculateBookingRisk,
  BASE_YELLOW_RATE,
  BASE_RED_RATE,
};
