<script lang="ts">
import RecipesCard from '/@/lib/RecipesCard.svelte';
import { catalog } from '/@/stores/catalog';
import type { Recipe } from '@shared/models/IRecipe';
import type { Category } from '@shared/models/ICategory';
import { Button, Dropdown, NavPage } from '@podman-desktop/ui-svelte';
import { Fa } from 'svelte-fa';
import { faGithub } from '@fortawesome/free-brands-svg-icons'; // Import the GitHub icon
import { studioClient } from '../utils/client';
import type { CatalogFilterKey, Choice, RecipeChoices, RecipeFilters } from '@shared/models/FilterRecipesResult';
import { onMount } from 'svelte';
import { configuration } from '../stores/extensionConfiguration';
import { SvelteMap } from 'svelte/reactivity';

// filters available in the dropdowns for the user to select
let choices: RecipeChoices = $state({});

// filters selected by the user
let filters = $state<RecipeFilters>({});

// the filtered recipes
let recipes: Recipe[] = $state([]);

// categoryDict is the list of categories in the catalog, derived from the catalog store
let categoryDict: { [k: string]: Category } = $derived(
  Object.fromEntries($catalog.categories.map(category => [category.id, category])),
);

// call filterRecipes every time the filters change
// and update the recipes and choices states with the result
$effect(() => {
  (async (): Promise<void> => {
    if (!filters) {
      return;
    }
    const snapshotFilters = $state.snapshot(filters);
    const result = await studioClient.filterRecipes(snapshotFilters);
    recipes = result.result;
    choices = result.choices;
  })().catch((err: unknown) => {
    console.error('unable to filter recipes with filters', filters, err);
  });
});

const UNCLASSIFIED: Category = {
  id: 'unclassified',
  name: 'Unclassified',
};

// compute the recipes by category
// - when categoryDict is initially set
// - every time `recipes` state changes
let groups: Map<Category, Recipe[]> = $derived.by(() => {
  if (!Object.keys(categoryDict).length) {
    return new Map();
  }
  const output: Map<Category, Recipe[]> = new SvelteMap();
  for (const recipe of recipes) {
    if (recipe.categories.length === 0) {
      output.set(UNCLASSIFIED, [...(output.get(UNCLASSIFIED) ?? []), recipe]);
      continue;
    }
    // iterate over all categories
    for (const categoryId of recipe.categories) {
      let key: Category;
      if (categoryId in categoryDict) {
        key = categoryDict[categoryId];
      } else {
        key = UNCLASSIFIED;
      }

      output.set(key, [...(output.get(key) ?? []), recipe]);
    }
  }
  return output;
});

function onFilterChange(filter: CatalogFilterKey, v: unknown): void {
  if (typeof v === 'string') {
    if (v.length) {
      filters[filter] = [v];
    } else {
      delete filters[filter];
    }
  }
}

// convert a list of choices provided by the backend to a list of options acceptable by the Dropdown component, adding an empty choice
function choicesToOptions(choices: Choice[] | undefined): { label: string; value: string }[] {
  return [
    { label: 'all', value: '' },
    ...(choices?.map(l => ({ value: l.name, label: `${l.name} (${l.count})` })) ?? []),
  ];
}

// add more filters here when the backend supports them
const filtersComponents: { label: string; key: CatalogFilterKey }[] = [
  { label: 'Tools', key: 'tools' },
  { label: 'Frameworks', key: 'frameworks' },
  { label: 'Languages', key: 'languages' },
];

function openContribution(): void {
  studioClient.openURL('https://github.com/containers/ai-lab-recipes/blob/main/CONTRIBUTING.md').catch(console.error);
}

let defaultRuntime: string | undefined = $state();

onMount(() => {
  const inferenceRuntime = $configuration?.inferenceRuntime;
  if (inferenceRuntime) defaultRuntime = inferenceRuntime;
  if (inferenceRuntime !== 'all') onFilterChange('tools', defaultRuntime ?? '');
});
</script>

<NavPage title="Recipe Catalog" searchEnabled={false}>
  <div slot="content" class="flex flex-col min-w-full min-h-full">
    <div class="min-w-full min-h-full flex-1">
      <div class="px-5 space-y-5">
        <!-- Add the summary here -->
        <div class="text-sm text-[var(--pd-modal-text)] space-y-3">
          <p>
            Recipes help you explore and get started with a number of core AI use cases like chatbots, code generators,
            text summarizers, agents, and more. Each recipe comes with detailed explanations and runnable source code
            compatible with various large language models (LLMs).
          </p>
          <p>
            Recipes are organized into categories:
            <span class="text-[var(--pd-link)]">audio, computer vision, multimodal, natural language processing</span>.
          </p>
          <p>Want to contribute more AI applications? The catalog is open source and available on GitHub!</p>
          <Button
            title="https://github.com/containers/ai-lab-recipes/blob/main/CONTRIBUTING.md"
            on:click={openContribution}
            size="lg">
            <div class="flex items-center space-x-2">
              <Fa icon={faGithub} />
              <span>Browse Recipe Repository</span>
            </div>
          </Button>
        </div>
        <div class="flex flex-row space-x-2 text-[var(--pd-modal-text)]">
          {#each filtersComponents as filterComponent (filterComponent.key)}
            <div class="w-full">
              <label for={filterComponent.key} class="block mb-2 text-sm font-medium">{filterComponent.label}</label>
              <Dropdown
                id={filterComponent.key}
                value={filterComponent.key === 'tools' ? defaultRuntime : ''}
                options={choicesToOptions(choices[filterComponent.key])}
                onChange={(v): void => onFilterChange(filterComponent.key, v)}></Dropdown>
            </div>
          {/each}
        </div>
        {#if groups}
          {#each groups.entries() as [category, recipes] (category.id)}
            <RecipesCard category={category} recipes={recipes} />
          {/each}
        {/if}
      </div>
    </div>
  </div>
</NavPage>
