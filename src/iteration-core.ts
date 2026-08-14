export function pausedByStepLimit(maxSteps: number, stepCount: number, finishReason: string): boolean {
  return maxSteps > 0 && stepCount >= maxSteps && finishReason === 'tool-calls';
}
