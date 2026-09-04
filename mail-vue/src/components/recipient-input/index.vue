<template>
  <div class="recipient-input-group">
    <el-input-tag
        class="recipient-input"
        :model-value="modelValue"
        :aria-label="label"
        @update:model-value="$emit('update:modelValue', $event)"
        @add-tag="$emit('add-tag', $event)"
        @input="$emit('input', $event)"
        @focus="$emit('activate')"
    >
      <template #prefix>
        <span class="recipient-label">{{ label }}</span>
      </template>
      <template #suffix>
        <el-button text circle :aria-label="`${label} contacts`" @click.stop="$emit('contacts')">
          <Icon icon="fa7-solid:user-plus" width="18" height="18" />
        </el-button>
      </template>
    </el-input-tag>
    <div v-if="suggestions.length" class="recipient-suggestions" :aria-label="`${label} suggestions`">
      <el-button
          v-for="suggestion in suggestions"
          :key="suggestion"
          text
          size="small"
          :aria-label="suggestion"
          @click="chooseSuggestion(suggestion)"
      >{{ suggestion }}</el-button>
    </div>
  </div>
</template>

<script setup>
import { Icon } from '@iconify/vue'

defineProps({
  modelValue: { type: Array, default: () => [] },
  label: { type: String, required: true },
  suggestions: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:modelValue', 'add-tag', 'input', 'activate', 'contacts', 'suggestion'])
function chooseSuggestion(value) {
  emit('suggestion', value)
}
</script>

<style scoped>
.recipient-input-group {
  display: grid;
  gap: 4px;
}

.recipient-label {
  color: var(--el-text-color-regular);
  min-width: 28px;
}

.recipient-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding-left: 4px;
}
</style>
