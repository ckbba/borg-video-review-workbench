import { describe, expect, it } from 'vitest';
import { CAMERA_RULE, withCameraRule } from './recreate';

describe('camera rule switch', () => {
  it('leaves the rules in use untouched unless switched on', () => {
    expect(withCameraRule('R3 rules', false)).toBe('R3 rules');
    expect(withCameraRule('R3 rules', true)).toBe(`R3 rules\n${CAMERA_RULE}`);
  });
});
