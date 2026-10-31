<script setup lang="ts">
import {computed} from 'vue'
import type {TaskResponse} from '@/client/queries/tasks'
import {treeTaskIds, type KanbanTreeNode} from '@/helpers/kanbanHierarchy'
import KanbanTreeRow from './KanbanTreeRow.vue'
import KanbanContextHeader from './KanbanContextHeader.vue'
import {treeChildrenId, useKanbanTree} from './kanbanTreeContext'

const props = defineProps<{
	node: KanbanTreeNode<TaskResponse>
	bucketId: number
}>()

const tree = useKanbanTree()
const hasChildren = computed(() => props.node.children.length > 0)
const expanded = computed(() => !tree.isCollapsed(props.bucketId, props.node.group))
const childrenId = computed(() => treeChildrenId(props.bucketId, props.node.group))
const groupSize = computed(() => treeTaskIds(props.node.children).length)
</script>

<template>
	<li
		class="kanban-tree-node"
		:class="`is-${node.kind}`"
	>
		<KanbanContextHeader
			v-if="node.kind === 'context'"
			:parent="node.parent"
			:trail="node.trail"
			:bucket-id="bucketId"
			:expanded="expanded"
			:group-size="groupSize"
			:children-id="expanded ? childrenId : undefined"
			@toggle="tree.toggleCollapsed(bucketId, node.group)"
		/>
		<KanbanTreeRow
			v-else
			:task="node.task"
			:bucket-id="bucketId"
			:trail="node.trail"
			:expanded="hasChildren ? expanded : undefined"
			:group-size="hasChildren ? groupSize : undefined"
			:children-id="hasChildren && expanded ? childrenId : undefined"
			@toggle="tree.toggleCollapsed(bucketId, node.group)"
		/>
		<ul
			v-if="hasChildren && expanded"
			:id="childrenId"
			class="kanban-tree-children"
		>
			<KanbanTreeNode
				v-for="child in node.children"
				:key="child.key"
				:node="child"
				:bucket-id="bucketId"
			/>
		</ul>
	</li>
</template>
