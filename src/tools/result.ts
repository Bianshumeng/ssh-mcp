export function asTextResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text',
      text: `${JSON.stringify(payload, null, 2)}\n`,
    }],
  };
}

