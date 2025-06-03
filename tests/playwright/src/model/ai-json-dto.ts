/**********************************************************************
 * Copyright (C) 2025 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import type { AIJsonCategoryDto } from './ai-json-category-dto';
import type { AIJsonModelDto } from './ai-json-model-dto';
import type { AIJsonRecipeDto } from './ai-json-recipe-dto';

export interface AIJsonDto {
  version: string;
  recipes: AIJsonRecipeDto[];
  models: AIJsonModelDto[];
  categories: AIJsonCategoryDto[];
}
