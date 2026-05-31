import type { ToolExecutor } from 'thread-phase';

// Digest agents are pure classifiers/writers and receive no callable tools.
export const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};
