function orderStations(stations, activity = []) {
  const times = new Map(activity.map(({ stationId, lastCallAt }) => [String(stationId), Number(lastCallAt)]));
  return stations.map((station, index) => ({ station, index }))
    .sort((a, b) => {
      if (a.station.disabled !== b.station.disabled) return Number(a.station.disabled) - Number(b.station.disabled);
      const aTime = times.get(String(a.station.id));
      const bTime = times.get(String(b.station.id));
      const aValid = Number.isFinite(aTime) ? aTime : -Infinity;
      const bValid = Number.isFinite(bTime) ? bTime : -Infinity;
      return bValid - aValid || a.index - b.index;
    })
    .map(({ station }) => station);
}

module.exports = { orderStations };
