/**
 * Node Registry - Central mapping of workflow node types to their React components
 * 
 * This provides a centralized way to:
 * - Register new node types
 * - Look up components by node type
 * - Check if a node type is supported
 */

import { ComponentType } from 'react';
import { NodeProps } from 'reactflow';
import { 
  TriggerNode, 
  ActionNode, 
  LogicNode, 
  DataNode, 
  OutputNode, 
  IntegrationNode 
} from './nodes/WorkflowNodes';

// Node group mapping - maps node type prefix to component
const NODE_GROUP_MAP: Record<string, ComponentType<NodeProps>> = {
  'trigger': TriggerNode,
  'zalo': ActionNode,
  'logic': LogicNode,
  'data': DataNode,
  'output': OutputNode,
  'sheets': IntegrationNode,
  'ai': IntegrationNode,
  'notify': IntegrationNode,
  'payment': IntegrationNode,
  'kiotviet': IntegrationNode,
  'haravan': IntegrationNode,
  'sapo': IntegrationNode,
  'ipos': IntegrationNode,
  'nhanh': IntegrationNode,
  'ghn': IntegrationNode,
  'ghtk': IntegrationNode,
};

/**
 * Get the node group from a node type
 * @param nodeType Full node type like 'trigger.message' or 'zalo.sendMessage'
 * @returns The group prefix (e.g., 'trigger', 'zalo', 'logic')
 */
export function getNodeGroup(nodeType: string): string {
  if (!nodeType) return '';
  const parts = nodeType.split('.');
  return parts[0] || '';
}

/**
 * Get the React component for a node type
 * @param nodeType Full node type like 'trigger.message' or 'zalo.sendMessage'
 * @returns The component to render this node, or null if not found
 */
export function getNodeComponent(nodeType: string): ComponentType<NodeProps> | null {
  const group = getNodeGroup(nodeType);
  return NODE_GROUP_MAP[group] || null;
}

/**
 * Check if a node type is registered
 * @param nodeType Full node type
 * @returns True if the node type has a registered component
 */
export function isNodeTypeRegistered(nodeType: string): boolean {
  const group = getNodeGroup(nodeType);
  return group in NODE_GROUP_MAP;
}

/**
 * Get all registered node groups
 * @returns Array of registered group prefixes
 */
export function getRegisteredGroups(): string[] {
  return Object.keys(NODE_GROUP_MAP);
}

/**
 * Register a new node group
 * @param group The group prefix (e.g., 'custom')
 * @param component The React component to use for this group
 */
export function registerNodeGroup(group: string, component: ComponentType<NodeProps>): void {
  NODE_GROUP_MAP[group] = component;
}

/**
 * Export the default node types object for ReactFlow
 * This is the object passed to ReactFlow's nodeTypes prop
 */
export const reactFlowNodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  logic: LogicNode,
  data: DataNode,
  output: OutputNode,
  integration: IntegrationNode,
};

export default {
  getNodeComponent,
  getNodeGroup,
  isNodeTypeRegistered,
  getRegisteredGroups,
  registerNodeGroup,
  reactFlowNodeTypes,
};

