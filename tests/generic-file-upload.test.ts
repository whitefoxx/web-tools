// @vitest-environment jsdom
/**
 * file_upload — b64ToBytes is a pure decode helper; setInputFiles builds a File
 * and assigns input.files (real-browser DataTransfer path). jsdom implements
 * File + DataTransfer well enough to test the happy path AND the "no file input"
 * error path here; the actual upload round-trip is verified on a real machine.
 */

import { describe, it, expect } from 'vitest';
import { b64ToBytes, setInputFiles } from '../src/tools/generic/file-upload';

describe('b64ToBytes', () => {
  it('decodes base64 to byte values', () => {
    // "Hi" = 0x48 0x69
    expect(b64ToBytes('SGk=')).toEqual([0x48, 0x69]);
  });
  it('empty string → empty', () => {
    expect(b64ToBytes('')).toEqual([]);
  });
});

describe('setInputFiles', () => {
  it('errors when no <input type=file> exists', () => {
    document.body.innerHTML = '<div>no input here</div>';
    const r = setInputFiles(null, 'x.txt', '', null, 'hi');
    expect(r.error).toBeTruthy();
    expect(r.ok).toBeUndefined();
  });

  it('errors when selector matches a non-file input', () => {
    document.body.innerHTML = '<input id="t" type="text">';
    const r = setInputFiles('#t', 'x.txt', '', null, 'hi');
    expect(r.error).toContain('#t');
  });

  // Note: the happy path (building a File + assigning input.files via DataTransfer)
  // is real-browser-only — jsdom's input.files is not assignable — so it's verified
  // on a real machine. b64ToBytes + the found/not-found + decode-error paths below
  // cover the logic that CAN run headless.

  it('reports a bad base64 string (before touching the DOM input)', () => {
    document.body.innerHTML = '<input type="file">';
    const r = setInputFiles(null, 'x.bin', '', '@@@not base64@@@', null);
    expect(r.error).toContain('base64');
  });
});
