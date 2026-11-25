function advanceIslandState(state, pointerInside, now, { leaveDelay, idleDelay }) {
  let { mode, leaveAt, idleAt } = state;

  if (pointerInside) {
    leaveAt = 0;
    idleAt = 0;
    if (mode === 'tucked') mode = 'compact';
  } else if (mode === 'expanded') {
    if (!leaveAt) leaveAt = now;
    if (now - leaveAt >= leaveDelay) {
      mode = 'compact';
      leaveAt = 0;
      idleAt = now;
    }
  } else if (mode === 'compact') {
    if (!idleAt) idleAt = now;
    if (now - idleAt >= idleDelay) {
      mode = 'tucked';
      idleAt = 0;
    }
  }

  return { mode, leaveAt, idleAt };
}

function toggleIslandMode(mode) {
  return mode === 'expanded' ? 'compact' : 'expanded';
}

module.exports = { advanceIslandState, toggleIslandMode };
