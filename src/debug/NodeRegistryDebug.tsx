import React, { useEffect } from 'react';
import { getAllNodeTypes } from '../components/appcreator_components/nodes/NodeRegistry';
import { getNodeExecutor, hasNodeExecutor } from '../nodeExecutors/NodeExecutorRegistry';

const NodeRegistryDebug = () => {
  useEffect(() => {
    // Check visual components registration
    const nodeTypes = getAllNodeTypes();
    console.log('Registered node types (visual components):', Object.keys(nodeTypes));

    // Check executor registration
    const nodeTypeIds = [
      'textInputNode',
      'imageInputNode',
      'baseLlmNode',
      'textOutputNode',
      'conditionalNode',
      'apiCallNode',
      'textCombinerNode', 
      'markdownOutputNode',
      'staticTextNode',
      'imageTextLlmNode'
    ];

    nodeTypeIds.forEach(id => {
      console.log(`Node '${id}' has executor: ${hasNodeExecutor(id)}`);
      if (hasNodeExecutor(id)) {
        console.log(`Node '${id}' executor:`, getNodeExecutor(id));
      }
    });

  }, []);

  return (
""
  );
};

export default NodeRegistryDebug;
