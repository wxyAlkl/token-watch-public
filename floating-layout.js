const BALL_SIZE = 76;
const PANEL_WIDTH = 344;

function panelBounds(position, area, stationCount = 0) {
  const width = Math.min(PANEL_WIDTH, Math.max(1, area.width - 16));
  const height = Math.min(258 + Math.max(1, Math.min(5, stationCount)) * 64, Math.max(1, area.height - 16));
  let x = position.x + BALL_SIZE + 10;
  if (x + width > area.x + area.width - 8) x = position.x - width - 10;
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
  const y = Math.max(area.y + 8, Math.min(position.y + BALL_SIZE / 2 - 46, area.y + area.height - height - 8));
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function islandBounds(area, mode = 'compact', stationCount = 0) {
  const stage = mode === true ? 'expanded' : mode === false ? 'compact' : mode;
  const tucked = stage === 'tucked';
  const expanded = stage === 'expanded';
  const width = Math.min(tucked ? 96 : expanded ? 520 : 260, Math.max(1, area.width - (tucked ? 0 : 12)));
  const topGap = tucked ? 0 : Math.min(4, Math.max(0, area.height - 1));
  const height = expanded
    ? Math.min(178 + Math.min(5, Math.max(1, stationCount)) * 72, Math.max(1, area.height - topGap))
    : Math.min(tucked ? 12 : 52, Math.max(1, area.height - topGap));
  return { x: Math.round(area.x + (area.width - width) / 2), y: area.y + topGap,
    width: Math.round(width), height: Math.round(height) };
}

module.exports = { BALL_SIZE, PANEL_WIDTH, panelBounds, islandBounds };
