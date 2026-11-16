// node --test src/winback/advent-double.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifiesForDoubleStamp, visitsForDoubleStamp } from './advent-double.ts';

test('semipermanente and above qualify; traditional and cleanup do not', () => {
  assert.equal(qualifiesForDoubleStamp('Semipermanente manos'), true);
  assert.equal(qualifiesForDoubleStamp('Semipermanente manos + tradicional pies'), true);
  assert.equal(qualifiesForDoubleStamp('Nivelación base rubber'), true);
  assert.equal(qualifiesForDoubleStamp('Retoque polygel'), true);
  assert.equal(qualifiesForDoubleStamp('Press on'), true);
  assert.equal(qualifiesForDoubleStamp('Tradicional manos'), false);
  assert.equal(qualifiesForDoubleStamp('Tradicional manos + pies'), false);
  assert.equal(qualifiesForDoubleStamp('Limpieza de pies'), false);
  assert.equal(qualifiesForDoubleStamp('Algo raro'), false);
});

test('only qualifying visits inside the gift dates are sent', () => {
  const visits = [
    { ref: 'a', date: '2026-12-30', serviceName: 'Semipermanente manos' },
    { ref: 'b', date: '2027-01-02', serviceName: 'Semipermanente manos' },
    { ref: 'c', date: '2027-01-15', serviceName: 'Tradicional manos' },
    { ref: 'd', date: '2027-01-31', serviceName: 'Retoque polygel' },
    { ref: 'e', date: '2027-02-01', serviceName: 'Retoque polygel' },
  ];
  assert.deepEqual(
    visitsForDoubleStamp(visits, '2027-01-01', '2027-01-31').map((v) => v.ref),
    ['b', 'd'],
  );
});
