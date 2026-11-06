/** Mode hints keep the name alongside; color is for presentation only and takes no part in adjudication. */
export const permissionModes = {
  default: {colorToken: 'permissionDefault', description: 'Reads run freely; writes, shell and network ask you unless an allow rule covers them.'},
  auto: {colorToken: 'permissionAuto', description: 'Ordinary edits and dev commands run freely; risky actions go to the review model, dangerous ones to you.'},
  creative: {colorToken: 'permissionCreative', description: 'Everything runs without asking except dangerous actions, which are denied; no review model.'},
} as const;
