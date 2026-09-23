import { describe, expect, it } from 'vitest';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../src/agent/bridge-instructions';

describe('BRIDGE_DEVELOPER_INSTRUCTIONS', () => {
  it('teaches the bridge-hosted agent how to use collaboration tools safely', () => {
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('wait_agent');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('绝不要放进 functions.exec');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('full-history fork');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('等待并汇总所有必要结果');
  });
});
