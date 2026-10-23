/** 模式提示同时保留名称；颜色只用于呈现，不参与裁决。 */
export const permissionModes = {
  default: {color: '#a8adb5', description: 'Normal reads allowed; other actions require human approval per rules'},
  auto: {color: '#70b7ff', description: 'Uncertain operations reviewed by the session model; dangerous actions need human confirmation'},
  creative: {color: '#d49aff', description: 'Rules block dangerous operations; everything else allowed without the approval model'},
} as const;
