// src/server/priceModel.js
// Price change prediction and selling price calculator

// FPL price change rules:
// - Prices range from 4.0 to 15.0 in 0.1 increments
// - Price rises when net transfers > threshold (varies by price bracket)
// - Price falls when net transfers < -threshold
// - Selling price = purchase_price + 0.5 * floor(profit)
// - Profit = current_price - purchase_price

// Price bracket thresholds for rises/falls (approximate, varies by price)
const RISE_THRESHOLDS = {
  '4.0-6.0': 60000,   // Lower price = easier to rise
  '6.1-8.0': 80000,
  '8.1-10.0': 100000,
  '10.1-15.0': 120000,
};

const FALL_THRESHOLDS = {
  '4.0-6.0': -55000,
  '6.1-8.0': -75000,
  '8.1-10.0': -95000,
  '10.1-15.0': -115000,
};

// Get price bracket
function getPriceBracket(price) {
  if (price <= 6.0) return '4.0-6.0';
  if (price <= 8.0) return '6.1-8.0';
  if (price <= 10.0) return '8.1-10.0';
  return '10.1-15.0';
}

// Calculate selling price given purchase price and current price
function calculateSellingPrice(purchasePrice, currentPrice) {
  const profit = currentPrice - purchasePrice;
  if (profit <= 0) return currentPrice; // selling at current price if no profit
  const halfProfit = Math.floor(profit * 10) / 20; // 50% of profit, rounded down to nearest 0.1
  return Math.round((purchasePrice + halfProfit) * 10) / 10;
}

// Predict price change direction and magnitude
function predictPriceChange(player, options = {}) {
  const currentPrice = Number(player.now_cost || player.cost || 0) / 10;
  const purchasePrice = Number(player.purchase_price || currentPrice) / 10;
  const transfersIn = Number(player.transfers_in || 0);
  const transfersOut = Number(player.transfers_out || 0);
  const selectedBy = Number(player.selected_by_percent || 0);

  const netTransfers = transfersIn - transfersOut;
  const bracket = getPriceBracket(currentPrice);
  const riseThreshold = RISE_THRESHOLDS[bracket];
  const fallThreshold = FALL_THRESHOLDS[bracket];

  // Predict rise
  let riseProbability = 0;
  if (netTransfers > 0) {
    riseProbability = Math.min(1, netTransfers / riseThreshold);
  }

  // Predict fall
  let fallProbability = 0;
  if (netTransfers < 0) {
    fallProbability = Math.min(1, Math.abs(netTransfers) / Math.abs(fallThreshold));
  }

  // Expected price change (in 0.1 increments)
  let expectedChange = 0;
  if (riseProbability > 0.8) expectedChange = 0.1;
  else if (riseProbability > 0.5) expectedChange = 0.05;
  else if (fallProbability > 0.8) expectedChange = -0.1;
  else if (fallProbability > 0.5) expectedChange = -0.05;

  const sellingPrice = calculateSellingPrice(purchasePrice, currentPrice);
  const profit = currentPrice - purchasePrice;

  return {
    currentPrice,
    purchasePrice,
    sellingPrice,
    profit: Math.round(profit * 10) / 10,
    netTransfers,
    riseProbability: Math.round(riseProbability * 100),
    fallProbability: Math.round(fallProbability * 100),
    expectedChange,
    selectedBy,
  };
}

module.exports = {
  calculateSellingPrice,
  predictPriceChange,
  getPriceBracket,
};
