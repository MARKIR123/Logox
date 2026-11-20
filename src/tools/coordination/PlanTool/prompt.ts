export const PLAN_TOOL_NAME = 'Plan';

export const PLAN_DESCRIPTION = `Maintain the plan for the current request: phases, steps and tasks (three levels), each with an owner, dependencies, acceptance checks and evidence. Create a plan when a request needs more than one piece of work; keep it current as the work changes; accept a node only on evidence.

- Link work to the plan: pass \`node\` when you dispatch with Actor or Automa; a node's status then follows that work by itself. You never set running, done or failed.
- Companions may split the node they own into sub-steps for themselves or for Automa, and accept those sub-steps; the Director accepts top-level nodes.
- People read and edit the plan file under .logox/plans/; ids in its comments stay fixed.`;
