// The base StoryLark site. All build mechanics live in the @storylark/core
// preset — this file only says where the brand folders are.
import { defineStorylarkConfig } from '@storylark/core/vite';

export default defineStorylarkConfig({ brandsRoot: '../brands' });
