import assert from 'node:assert/strict';
import test from 'node:test';
import { locationOccupations, type LocationStay } from './location-occupations.js';

test('ocupaciones continuas, animales únicos, fechas del movimiento y descanso previo', () => {
  const stay = (animalId: string, start: string, end: string | null,
    startedOn = start.slice(0, 10), endedOn = end?.slice(0, 10) ?? null): LocationStay => ({
    locationId: 'pasture', animalId, startedAt: start, endedAt: end, startedOn, endedOn,
  });
  const result = locationOccupations([
    // Re-entry by the same animal, while another remains, must not inflate the count.
    stay('a', '2026-09-01T15:00:00Z', '2026-09-05T15:00:00Z'),
    stay('b', '2026-09-02T15:00:00Z', '2026-09-10T15:00:00Z'),
    stay('a', '2026-09-05T15:00:00Z', '2026-09-08T15:00:00Z'),
    // Dates reflect a backdated movement, rather than when it was applied.
    stay('c', '2026-09-25T15:00:00Z', '2026-09-27T15:00:00Z', '2026-09-20', '2026-09-26'),
    stay('d', '2026-10-01T15:00:00Z', null),
    stay('e', '2026-10-02T15:00:00Z', '2026-10-03T15:00:00Z'),
  ].reverse(), '2026-08-20');
  assert.equal(result.currentAnimalCount, 1);
  assert.deepEqual(result.occupationHistory, [
    {startedOn: '2026-10-01', endedOn: null, animalCount: 2, restStartedOn: '2026-09-26'},
    {startedOn: '2026-09-20', endedOn: '2026-09-26', animalCount: 1, restStartedOn: '2026-09-10'},
    {startedOn: '2026-09-01', endedOn: '2026-09-10', animalCount: 2, restStartedOn: '2026-08-20'},
  ]);
  assert.deepEqual(locationOccupations([], null), {currentAnimalCount: 0, occupationHistory: []});
  assert.equal(locationOccupations([stay('a', '2026-09-01T15:00:00Z', null)],
    '2026-10-01').occupationHistory[0]?.restStartedOn, null);
  assert.equal(locationOccupations([
    stay('a', '2026-09-01T15:00:00Z', '2026-09-01T16:00:00Z'),
    stay('b', '2026-09-01T17:00:00Z', null),
  ], null).occupationHistory.length, 2);
});
