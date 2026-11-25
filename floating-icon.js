// Small original tray glyph: status ring plus a T. No external assets needed.
function trayBitmap(color = [64, 184, 139], size = 32) {
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + 0.5) / size, py = (y + 0.5) / size;
    const distance = Math.hypot(px - 0.5, py - 0.5);
    if (distance > 0.48) continue;
    let rgb = distance > 0.36 ? color : [23, 38, 53];
    if ((py > 0.28 && py < 0.39 && px > 0.29 && px < 0.71) || (py >= 0.39 && py < 0.73 && px > 0.45 && px < 0.55)) rgb = [237, 244, 249];
    const offset = (y * size + x) * 4;
    bitmap[offset] = rgb[2]; bitmap[offset + 1] = rgb[1]; bitmap[offset + 2] = rgb[0]; bitmap[offset + 3] = 255;
  }
  return bitmap;
}

module.exports = { trayBitmap };
