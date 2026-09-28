import { CoordinatorError, validateStakeHundredths, type PointHundredths } from './types';

export function calculateWinPayout(stakeHundredths: PointHundredths): {
  winnerCreditHundredths: PointHundredths;
  houseFeeHundredths: PointHundredths;
} {
  const stake = validateStakeHundredths(stakeHundredths);
  const fee = stake / 10;
  if (!Number.isInteger(fee)) {
    throw new CoordinatorError('INVALID_INPUT', 'stakeHundredths must be a whole-point amount');
  }

  return {
    winnerCreditHundredths: 2 * stake - fee,
    houseFeeHundredths: fee,
  };
}
