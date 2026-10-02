import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainModel, parseFamilies, registrableDomain } from '../src/domain.js';

test('every language edition of a site is one registrable domain', () => {
  for (const lang of ['en', 'de', 'fr', 'ja', 'zh-min-nan']) assert.equal(registrableDomain(`${lang}.wikipedia.org`), 'wikipedia.org');
  assert.equal(registrableDomain('wikipedia.org'), 'wikipedia.org');
  assert.equal(registrableDomain('EN.Wikipedia.ORG'), 'wikipedia.org');
});
test('multi-label public suffixes are respected', () => {
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('a.b.example.com.au'), 'example.com.au');
});
test('private suffixes separate unrelated sites that share a platform', () => {
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.notEqual(registrableDomain('alice.github.io'), registrableDomain('bob.github.io'));
  assert.equal(registrableDomain('x.blogspot.com'), 'x.blogspot.com');
});
test('hosts without a registrable domain are their own domain', () => {
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('192.168.0.1'), '192.168.0.1');
});
test('families are explicit and never guessed', () => {
  const model = new DomainModel(parseFamilies('wikimedia=wikipedia.org,wikimedia.org,wiktionary.org'));
  assert.equal(model.familyOf('en.wikipedia.org'), 'wikimedia'); assert.equal(model.familyOf('commons.wikimedia.org'), 'wikimedia');
  assert.equal(model.familyOf('example.org'), 'example.org'); assert.equal(new DomainModel().familyOf('en.wikipedia.org'), 'wikipedia.org');
  assert.throws(() => new DomainModel({ a: ['x.org'], b: ['x.org'] }));
  assert.throws(() => parseFamilies('nonsense')); assert.throws(() => parseFamilies('a=bad domain'));
});
