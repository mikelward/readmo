import { describe, expect, it } from 'vitest';
import { openModeOf } from './types';

describe('openModeOf', () => {
  it('is reader when neither flag is set', () => {
    expect(openModeOf({ openOriginal: false, openNewshacker: false })).toBe('reader');
  });

  it('is original when only openOriginal is set', () => {
    expect(openModeOf({ openOriginal: true, openNewshacker: false })).toBe('original');
  });

  it('is newshacker when only openNewshacker is set', () => {
    expect(openModeOf({ openOriginal: false, openNewshacker: true })).toBe('newshacker');
  });

  it('gives original precedence if both are somehow set (a legacy open_original write)', () => {
    expect(openModeOf({ openOriginal: true, openNewshacker: true })).toBe('original');
  });
});
