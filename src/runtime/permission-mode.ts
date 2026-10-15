/** 模式提示同时保留名称；颜色只用于呈现，不参与裁决。 */
export const permissionModes = {
  default: {color: '#a8adb5', description: '普通读取允许，其余按规则人工审批'},
  auto: {color: '#70b7ff', description: '不确定操作由会话模型审查，危险操作人工确认'},
  creative: {color: '#d49aff', description: '规则过滤危险操作，其余允许；不调用审批模型'},
} as const;
