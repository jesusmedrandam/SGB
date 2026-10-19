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
  assert.deepEqual(result.occupationHistory.map(({segments,durationDays,...period})=>period), [
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
  ], null).occupationHistory.length, 1);
});

test('seis días con 55 y 57 animales, sin inflar por entradas de cero días y relevos de grupos',()=>{
 const stay=(id:string,start:string,end:string|null):LocationStay=>({locationId:'pasture',animalId:id,
  startedAt:start+'T12:00:00Z',endedAt:end?end+'T12:00:00Z':null,startedOn:start,endedOn:end});
 const stays=[...Array.from({length:55},(_,n)=>stay('animal-'+n,'2026-10-01','2026-10-07')),
  stay('extra-a','2026-10-04','2026-10-07'),stay('extra-b','2026-10-04','2026-10-07'),
  ...Array.from({length:20},(_,n)=>stay('zero-'+n,'2026-10-03','2026-10-03'))];
 const result=locationOccupations(stays,'2026-09-20','2026-10-18').occupationHistory[0]!;
 assert.equal(result.durationDays,6);assert.equal(result.animalCount,57);
 assert.deepEqual(result.segments.map(row=>[row.days,row.animalCount]),[[3,55],[3,57]]);
 const relay=locationOccupations([stay('first','2026-10-01','2026-10-04'),stay('second','2026-10-04','2026-10-11')],null,'2026-10-18');
 assert.equal(relay.occupationHistory.length,1);assert.equal(relay.occupationHistory[0]!.durationDays,10);
 assert.equal(relay.occupationHistory[0]!.animalCount,1,'Successive groups are not added together');
 assert.equal(locationOccupations([stay('first','2026-10-01','2026-10-04'),stay('second','2026-10-05',null)],null,'2026-10-18').occupationHistory.length,2);
 assert.equal(locationOccupations([{...stay('separated','2026-10-01',null),countsForOccupancy:false}],null,'2026-10-18').currentAnimalCount,0);
 assert.equal(locationOccupations([stay('zero','2026-10-01','2026-10-01')],null,'2026-10-18').occupationHistory.length,0);
 const pause=[stay('first','2026-10-01','2026-10-04'),stay('second','2026-10-11','2026-10-14')];
 const reusable=locationOccupations(pause,null,'2026-10-18',[{observedOn:'2026-10-04',exitState:'REMAINS'}]).occupationHistory;
 assert.equal(reusable.length,1);assert.equal(reusable[0]!.durationDays,6,'Seven days without animals are not grazing days');
 assert.deepEqual(reusable[0]!.pauses,[{startedOn:'2026-10-04',endedOn:'2026-10-11',days:7}]);
 assert.equal(locationOccupations(pause,null,'2026-10-18',[{observedOn:'2026-10-04',exitState:'DEPLETED'}]).occupationHistory.length,2);
 assert.equal(locationOccupations([pause[0]!,stay('second','2026-10-12','2026-10-14')],null,'2026-10-18',[{observedOn:'2026-10-04',exitState:'REMAINS'}]).occupationHistory.length,2);
});
