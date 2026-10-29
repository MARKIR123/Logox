/** 模式提示同时保留名称；颜色只用于呈现，不参与裁决。 */
export const permissionModes = {
  default: {colorToken: 'permissionDefault', description: 'Normal reads allowed; other actions require human approval per rules'},
  auto: {colorToken: 'permissionAuto', description: 'Uncertain operations reviewed by the session model; dangerous actions need human confirmation'},
  creative: {colorToken: 'permissionCreative', description: 'Rules block dangerous operations; everything else allowed without the approval model'},
} as const;
