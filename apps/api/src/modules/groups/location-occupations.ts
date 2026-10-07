export interface LocationStay {
  locationId: string; animalId: string; startedAt: string; endedAt: string | null;
  startedOn: string; endedOn: string | null;
}
export interface LocationOccupation {
  startedOn: string; endedOn: string | null; animalCount: number;
  restStartedOn: string | null;
}

// Continuous presence is one occupation, including overlapping stays and changes of group.
export function locationOccupations(stays: LocationStay[], initialRest: string | null) {
  const periods: Array<{start: number; end: number; startedOn: string; endedOn: string | null;
    animals: Set<string>}> = [];
  const currentAnimals = new Set<string>();
  for (const stay of [...stays].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const start = Date.parse(stay.startedAt);
    const end = stay.endedAt === null ? Infinity : Date.parse(stay.endedAt);
    if (stay.endedAt === null) currentAnimals.add(stay.animalId);
    const previous = periods.at(-1);
    if (!previous || start > previous.end) {
      periods.push({start, end, startedOn: stay.startedOn, endedOn: stay.endedOn,
        animals: new Set([stay.animalId])});
    } else {
      previous.animals.add(stay.animalId);
      if (end > previous.end) {
        previous.end = end;
        previous.endedOn = stay.endedOn;
      }
    }
  }
  const occupationHistory: LocationOccupation[] = periods.map((period, index) => ({
    startedOn: period.startedOn, endedOn: period.endedOn, animalCount: period.animals.size,
    restStartedOn: index > 0 ? periods[index - 1]!.endedOn
      : initialRest && initialRest <= period.startedOn ? initialRest : null,
  }));
  return {currentAnimalCount: currentAnimals.size, occupationHistory: occupationHistory.reverse()};
}
