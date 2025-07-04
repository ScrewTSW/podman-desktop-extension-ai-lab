/**********************************************************************
 * Copyright (C) 2024 Red Hat, Inc.
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

import type { RecipeComponents, RecipeImage } from '@shared/models/IRecipe';
import * as path from 'node:path';
import { containerEngine, Disposable, window, ProgressLocation } from '@podman-desktop/api';
import type {
  PodCreatePortOptions,
  TelemetryLogger,
  PodInfo,
  HostConfig,
  HealthConfig,
  PodContainerInfo,
  ContainerProviderConnection,
} from '@podman-desktop/api';
import type { ModelsManager } from '../modelsManager';
import { getPortsFromLabel, getPortsInfo } from '../../utils/ports';
import { getDurationSecondsSince, timeout } from '../../utils/utils';
import type { ApplicationState } from '@shared/models/IApplicationState';
import type { PodmanConnection } from '../podmanConnection';
import { MSG_APPLICATIONS_STATE_UPDATE } from '@shared/Messages';
import type { CatalogManager } from '../catalogManager';
import { ApplicationRegistry } from '../../registries/ApplicationRegistry';
import type { TaskRegistry } from '../../registries/TaskRegistry';
import { Publisher } from '../../utils/Publisher';
import { getModelPropertiesForEnvironment } from '../../utils/modelsUtils';
import { getRandomName, getRandomString } from '../../utils/randomUtils';
import type { PodManager } from '../recipes/PodManager';
import { SECOND } from '../../workers/provider/LlamaCppPython';
import type { RecipeManager } from '../recipes/RecipeManager';
import {
  POD_LABEL_APP_PORTS,
  POD_LABEL_MODEL_ID,
  POD_LABEL_MODEL_PORTS,
  POD_LABEL_RECIPE_ID,
} from '../../utils/RecipeConstants';
import { VMType } from '@shared/models/IPodman';
import { RECIPE_START_ROUTE } from '../../registries/NavigationRegistry';
import type { RpcExtension } from '@shared/messages/MessageProxy';
import { TaskRunner } from '../TaskRunner';
import { getInferenceType } from '../../utils/inferenceUtils';
import type { LlamaStackManager } from '../llama-stack/llamaStackManager';
import { isApplicationOptionsWithModelInference, type ApplicationOptions } from '../../models/ApplicationOptions';

export class ApplicationManager extends Publisher<ApplicationState[]> implements Disposable {
  #applications: ApplicationRegistry<ApplicationState>;
  protectTasks: Set<string> = new Set();
  #disposables: Disposable[];
  #taskRunner: TaskRunner;

  constructor(
    private taskRegistry: TaskRegistry,
    rpcExtension: RpcExtension,
    private podmanConnection: PodmanConnection,
    private catalogManager: CatalogManager,
    private modelsManager: ModelsManager,
    private telemetry: TelemetryLogger,
    private podManager: PodManager,
    private recipeManager: RecipeManager,
    private llamaStackManager: LlamaStackManager,
  ) {
    super(rpcExtension, MSG_APPLICATIONS_STATE_UPDATE, () => this.getApplicationsState());
    this.#applications = new ApplicationRegistry<ApplicationState>();
    this.#taskRunner = new TaskRunner(this.taskRegistry);
    this.#disposables = [];
  }

  async requestPullApplication(options: ApplicationOptions): Promise<string> {
    // create a tracking id to put in the labels
    const trackingId: string = getRandomString();

    const labels: Record<string, string> = {
      trackingId: trackingId,
    };

    this.#taskRunner
      .runAsTask(
        {
          ...labels,
          'recipe-pulling': options.recipe.id, // this label should only be on the master task
        },
        {
          loadingLabel: `Pulling ${options.recipe.name} recipe`,
          errorMsg: err => `Something went wrong while pulling ${options.recipe.name}: ${String(err)}`,
        },
        () =>
          window.withProgress(
            {
              location: ProgressLocation.TASK_WIDGET,
              title: `Pulling ${options.recipe.name}.`,
              details: {
                routeId: RECIPE_START_ROUTE,
                routeArgs: [options.recipe.id, trackingId],
              },
            },
            () => this.pullApplication(options, labels),
          ),
      )
      .catch(() => {});

    return trackingId;
  }

  async pullApplication(options: ApplicationOptions, labels: Record<string, string> = {}): Promise<void> {
    let modelId: string;
    if (isApplicationOptionsWithModelInference(options)) {
      modelId = options.model.id;
    } else {
      modelId = '<none>';
    }

    // clear any existing status / tasks related to the pair recipeId-modelId.
    this.taskRegistry.deleteByLabels({
      'recipe-id': options.recipe.id,
      'model-id': modelId,
    });

    const startTime = performance.now();
    try {
      // init application (git clone, models download etc.)
      const podInfo: PodInfo = await this.initApplication(options, labels);
      // start the pod
      await this.runApplication(podInfo, {
        ...labels,
        'recipe-id': options.recipe.id,
        'model-id': modelId,
      });

      // measure init + start time
      const durationSeconds = getDurationSecondsSince(startTime);
      this.telemetry.logUsage('recipe.pull', {
        'recipe.id': options.recipe.id,
        'recipe.name': options.recipe.name,
        durationSeconds,
      });
    } catch (err: unknown) {
      const durationSeconds = getDurationSecondsSince(startTime);
      this.telemetry.logError('recipe.pull', {
        'recipe.id': options.recipe.id,
        'recipe.name': options.recipe.name,
        durationSeconds,
        message: 'error pulling application',
        error: err,
      });
      throw err;
    }
  }

  /**
   * This method will execute the following tasks
   * - git clone
   * - git checkout
   * - register local repository
   * - download models
   * - upload models
   * - build containers
   * - create pod
   *
   * @param connection
   * @param recipe
   * @param model
   * @param labels
   * @private
   */
  private async initApplication(options: ApplicationOptions, labels: Record<string, string> = {}): Promise<PodInfo> {
    let modelId: string;
    if (isApplicationOptionsWithModelInference(options)) {
      modelId = options.model.id;
    } else {
      modelId = '<none>';
    }

    // clone the recipe
    await this.recipeManager.cloneRecipe(options.recipe, { ...labels, 'model-id': modelId });

    let modelPath: string | undefined;
    if (isApplicationOptionsWithModelInference(options)) {
      // get model by downloading it or retrieving locally
      modelPath = await this.modelsManager.requestDownloadModel(options.model, {
        ...labels,
        'recipe-id': options.recipe.id,
        'model-id': modelId,
      });
    }
    // build all images, one per container (for a basic sample we should have 2 containers = sample app + model service)
    const recipeComponents = await this.recipeManager.buildRecipe(options, {
      ...labels,
      'recipe-id': options.recipe.id,
      'model-id': modelId,
    });

    if (isApplicationOptionsWithModelInference(options)) {
      // upload model to podman machine if user system is supported
      if (!recipeComponents.inferenceServer) {
        modelPath = await this.modelsManager.uploadModelToPodmanMachine(options.connection, options.model, {
          ...labels,
          'recipe-id': options.recipe.id,
          'model-id': modelId,
        });
      }
    }

    // first delete any existing pod with matching labels
    if (await this.hasApplicationPod(options.recipe.id, modelId)) {
      await this.removeApplication(options.recipe.id, modelId);
    }

    // create a pod containing all the containers to run the application
    return this.createApplicationPod(options, recipeComponents, modelPath, {
      ...labels,
      'recipe-id': options.recipe.id,
      'model-id': modelId,
    });
  }

  /**
   * Given an ApplicationPodInfo, start the corresponding pod
   * @param podInfo
   * @param labels
   */
  protected async runApplication(podInfo: PodInfo, labels?: { [key: string]: string }): Promise<void> {
    await this.#taskRunner.runAsTask(
      labels ?? {},
      {
        loadingLabel: 'Starting AI App',
        successLabel: 'AI App is running',
        errorMsg: err => String(err),
      },
      async () => {
        await this.podManager.startPod(podInfo.engineId, podInfo.Id);

        // check if all containers have started successfully
        for (const container of podInfo.Containers ?? []) {
          await this.waitContainerIsRunning(podInfo.engineId, container);
        }
      },
    );
    return this.checkPodsHealth();
  }

  protected async waitContainerIsRunning(engineId: string, container: PodContainerInfo): Promise<void> {
    const TIME_FRAME_MS = 5000;
    const MAX_ATTEMPTS = 60 * (60000 / TIME_FRAME_MS); // try for 1 hour
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const sampleAppContainerInspectInfo = await containerEngine.inspectContainer(engineId, container.Id);
      if (sampleAppContainerInspectInfo.State.Running) {
        return;
      }
      await timeout(TIME_FRAME_MS);
    }
    throw new Error(`Container ${container.Id} not started in time`);
  }

  protected async createApplicationPod(
    options: ApplicationOptions,
    components: RecipeComponents,
    modelPath: string | undefined,
    labels?: { [key: string]: string },
  ): Promise<PodInfo> {
    return this.#taskRunner.runAsTask<PodInfo>(
      labels ?? {},
      {
        loadingLabel: 'Creating AI App',
        errorMsg: err => `Something went wrong while creating pod: ${String(err)}`,
      },
      async ({ updateLabels }): Promise<PodInfo> => {
        const podInfo = await this.createPod(options, components.images);
        updateLabels(labels => ({
          ...labels,
          'pod-id': podInfo.Id,
        }));
        await this.createContainerAndAttachToPod(options, podInfo, components, modelPath, labels);
        return podInfo;
      },
    );
  }

  protected async createContainerAndAttachToPod(
    options: ApplicationOptions,
    podInfo: PodInfo,
    components: RecipeComponents,
    modelPath: string | undefined,
    labels?: { [key: string]: string },
  ): Promise<void> {
    const vmType = options.connection.vmType ?? VMType.UNKNOWN;
    // temporary check to set Z flag or not - to be removed when switching to podman 5
    await Promise.all(
      components.images.map(async image => {
        let hostConfig: HostConfig | undefined = undefined;
        let envs: string[] = [];
        let healthcheck: HealthConfig | undefined = undefined;
        // if it's a model service we mount the model as a volume
        if (modelPath && isApplicationOptionsWithModelInference(options)) {
          if (image.modelService) {
            const modelName = path.basename(modelPath);
            hostConfig = {
              Mounts: [
                {
                  Target: `/${modelName}`,
                  Source: modelPath,
                  Type: 'bind',
                  Mode: vmType === VMType.QEMU ? undefined : 'Z',
                },
              ],
            };
            envs = [`MODEL_PATH=/${modelName}`];
            envs.push(...getModelPropertiesForEnvironment(options.model));
          } else if (components.inferenceServer) {
            const endPoint = `http://host.containers.internal:${components.inferenceServer.connection.port}`;
            envs = [`MODEL_ENDPOINT=${endPoint}`];
          } else {
            const modelService = components.images.find(image => image.modelService);
            if (modelService && modelService.ports.length > 0) {
              const endPoint = `http://localhost:${modelService.ports[0]}`;
              envs = [`MODEL_ENDPOINT=${endPoint}`];
            }
          }
        } else if (options.dependencies?.llamaStack) {
          let stack = await this.llamaStackManager.getLlamaStackContainer();
          if (!stack) {
            await this.llamaStackManager.createLlamaStackContainer(options.connection, labels ?? {});
            stack = await this.llamaStackManager.getLlamaStackContainer();
          }
          if (stack) {
            envs = [`MODEL_ENDPOINT=http://host.containers.internal:${stack.port}`];
          }
        }
        if (image.ports.length > 0) {
          healthcheck = {
            // must be the port INSIDE the container not the exposed one
            Test: ['CMD-SHELL', `curl -s localhost:${image.ports[0]} > /dev/null`],
            Interval: SECOND * 5,
            Retries: 4 * 5,
            Timeout: SECOND * 2,
          };
        }

        const podifiedName = getRandomName(`${image.appName}-podified`);
        await containerEngine.createContainer(podInfo.engineId, {
          Image: image.id,
          name: podifiedName,
          Detach: true,
          HostConfig: hostConfig,
          Env: envs,
          start: false,
          pod: podInfo.Id,
          HealthCheck: healthcheck,
        });
      }),
    );
  }

  protected async createPod(options: ApplicationOptions, images: RecipeImage[]): Promise<PodInfo> {
    // find the exposed port of the sample app so we can open its ports on the new pod
    const sampleAppImageInfo = images.find(image => !image.modelService);
    if (!sampleAppImageInfo) {
      console.error('no sample app image found');
      throw new Error('no sample app found');
    }

    const portmappings: PodCreatePortOptions[] = [];
    // we expose all ports so we can check the model service if it is actually running
    for (const image of images) {
      for (const exposed of image.ports) {
        const localPorts = await getPortsInfo(exposed);
        if (localPorts) {
          portmappings.push({
            container_port: parseInt(exposed),
            host_port: parseInt(localPorts),
            host_ip: '',
            protocol: '',
            range: 1,
          });
        }
      }
    }

    // create new pod
    const labels: Record<string, string> = {
      [POD_LABEL_RECIPE_ID]: options.recipe.id,
    };

    if (isApplicationOptionsWithModelInference(options)) {
      labels[POD_LABEL_MODEL_ID] = options.model.id;
    } else {
      labels[POD_LABEL_MODEL_ID] = '<none>';
    }
    // collecting all modelService ports
    const modelPorts = images
      .filter(img => img.modelService)
      .flatMap(img => img.ports)
      .map(port => portmappings.find(pm => `${pm.container_port}` === port)?.host_port);
    if (modelPorts.length) {
      labels[POD_LABEL_MODEL_PORTS] = modelPorts.join(',');
    }
    // collecting all application ports (excluding service ports)
    const appPorts = images
      .filter(img => !img.modelService)
      .flatMap(img => img.ports)
      .map(port => portmappings.find(pm => `${pm.container_port}` === port)?.host_port);
    if (appPorts.length) {
      labels[POD_LABEL_APP_PORTS] = appPorts.join(',');
    }
    const { engineId, Id } = await this.podManager.createPod({
      provider: options.connection,
      name: getRandomName(`pod-${sampleAppImageInfo.appName}`),
      portmappings: portmappings,
      labels,
    });

    return this.podManager.getPod(engineId, Id);
  }

  /**
   * Stop the pod with matching recipeId and modelId
   * @param recipeId
   * @param modelId
   */
  async stopApplication(recipeId: string, modelId: string): Promise<PodInfo> {
    // clear existing tasks
    this.clearTasks(recipeId, modelId);

    // get the application pod
    const appPod = await this.getApplicationPod(recipeId, modelId);

    // if the pod is already stopped skip
    if (appPod.Status !== 'Exited') {
      await this.#taskRunner.runAsTask(
        {
          'recipe-id': recipeId,
          'model-id': modelId,
        },
        {
          loadingLabel: 'Stopping AI App',
          successLabel: 'AI App Stopped',
          errorLabel: 'Error stopping AI App',
          errorMsg: err => `Error removing the pod.: ${String(err)}`,
        },
        () => this.podManager.stopPod(appPod.engineId, appPod.Id),
      );
      await this.checkPodsHealth();
    }
    return appPod;
  }

  /**
   * Utility method to start a pod using (recipeId, modelId)
   * @param recipeId
   * @param modelId
   */
  async startApplication(recipeId: string, modelId: string): Promise<void> {
    this.clearTasks(recipeId, modelId);
    const pod = await this.getApplicationPod(recipeId, modelId);

    return this.runApplication(pod, {
      'recipe-id': recipeId,
      'model-id': modelId,
    });
  }

  protected refresh(): void {
    // clear existing applications
    this.#applications.clear();
    // collect all pods based on label
    this.podManager
      .getPodsWithLabels([POD_LABEL_RECIPE_ID])
      .then(pods => {
        pods.forEach(pod => this.adoptPod(pod));
      })
      .catch((err: unknown) => {
        console.error('error during adoption of existing playground containers', err);
      });
    // notify
    this.notify();
  }

  init(): void {
    this.podmanConnection.onPodmanConnectionEvent(() => {
      this.refresh();
    });

    this.podManager.onStartPodEvent((pod: PodInfo) => {
      this.adoptPod(pod);
    });
    this.podManager.onRemovePodEvent(({ podId }) => {
      this.forgetPodById(podId);
    });

    const ticker = (): void => {
      this.checkPodsHealth()
        .catch((err: unknown) => {
          console.error('error getting pods statuses', err);
        })
        .finally(() => (timerId = setTimeout(ticker, 10000)));
    };

    // using a recursive setTimeout instead of setInterval as we don't know how long the operation takes
    let timerId = setTimeout(ticker, 1000);

    this.#disposables.push(
      Disposable.create(() => {
        clearTimeout(timerId);
      }),
    );

    // refresh on init
    this.refresh();
  }

  protected adoptPod(pod: PodInfo): void {
    if (!pod.Labels) {
      return;
    }
    const recipeId = pod.Labels[POD_LABEL_RECIPE_ID];
    const modelId = pod.Labels[POD_LABEL_MODEL_ID];
    if (!recipeId || !modelId) {
      return;
    }
    const appPorts = getPortsFromLabel(pod.Labels, POD_LABEL_APP_PORTS);
    const modelPorts = getPortsFromLabel(pod.Labels, POD_LABEL_MODEL_PORTS);
    if (this.#applications.has({ recipeId, modelId })) {
      return;
    }
    const state: ApplicationState = {
      recipeId,
      modelId,
      pod,
      appPorts,
      modelPorts,
      health: 'starting',
      backend: getInferenceType(this.modelsManager.getModelsInfo().filter(m => m.id === modelId)),
    };
    this.updateApplicationState(recipeId, modelId, state);
  }

  protected forgetPodById(podId: string): void {
    const app = Array.from(this.#applications.values()).find(p => p.pod.Id === podId);
    if (!app) {
      return;
    }
    if (!app.pod.Labels) {
      return;
    }
    const recipeId = app.pod.Labels[POD_LABEL_RECIPE_ID];
    const modelId = app.pod.Labels[POD_LABEL_MODEL_ID];
    if (!recipeId || !modelId) {
      return;
    }
    if (!this.#applications.has({ recipeId, modelId })) {
      return;
    }
    this.#applications.delete({ recipeId, modelId });
    this.notify();

    const protect = this.protectTasks.has(podId);
    if (!protect) {
      this.taskRegistry.createTask('AI App stopped manually', 'success', {
        'recipe-id': recipeId,
        'model-id': modelId,
      });
    } else {
      this.protectTasks.delete(podId);
    }
  }

  protected async checkPodsHealth(): Promise<void> {
    const pods = await this.podManager.getPodsWithLabels([POD_LABEL_RECIPE_ID, POD_LABEL_MODEL_ID]);
    let changes = false;

    for (const pod of pods) {
      const recipeId = pod.Labels[POD_LABEL_RECIPE_ID];
      const modelId = pod.Labels[POD_LABEL_MODEL_ID];
      if (!this.#applications.has({ recipeId, modelId })) {
        // a fresh pod could not have been added yet, we will handle it at next iteration
        continue;
      }

      const podHealth = await this.podManager.getHealth(pod);
      const state = this.#applications.get({ recipeId, modelId });
      if (state.health !== podHealth) {
        state.health = podHealth;
        state.pod = pod;
        this.#applications.set({ recipeId, modelId }, state);
        changes = true;
      }
      if (pod.Status !== state.pod.Status) {
        state.pod = pod;
        changes = true;
      }
    }
    if (changes) {
      this.notify();
    }
  }

  protected updateApplicationState(recipeId: string, modelId: string, state: ApplicationState): void {
    this.#applications.set({ recipeId, modelId }, state);
    this.notify();
  }

  getApplicationsState(): ApplicationState[] {
    return Array.from(this.#applications.values());
  }

  protected clearTasks(recipeId: string, modelId: string): void {
    // clear any existing status / tasks related to the pair recipeId-modelId.
    this.taskRegistry.deleteByLabels({
      'recipe-id': recipeId,
      'model-id': modelId,
    });
  }

  /**
   * Method that will stop then remove a pod corresponding to the recipe and model provided
   * @param recipeId
   * @param modelId
   */
  async removeApplication(recipeId: string, modelId: string): Promise<void> {
    const appPod = await this.stopApplication(recipeId, modelId);

    this.protectTasks.add(appPod.Id);

    await this.#taskRunner.runAsTask(
      {
        'recipe-id': recipeId,
        'model-id': modelId,
      },
      {
        loadingLabel: 'Removing AI App',
        successLabel: 'AI App Removed',
        errorLabel: 'Error stopping AI App',
        errorMsg: () => 'error removing the pod. Please try to remove the pod manually',
      },
      () => this.podManager.removePod(appPod.engineId, appPod.Id),
    );
  }

  async restartApplication(connection: ContainerProviderConnection, recipeId: string, modelId: string): Promise<void> {
    const appPod = await this.getApplicationPod(recipeId, modelId);
    await this.removeApplication(recipeId, modelId);
    const recipe = this.catalogManager.getRecipeById(recipeId);
    let opts: ApplicationOptions;
    if (appPod.Labels[POD_LABEL_MODEL_ID] === '<none>') {
      opts = {
        connection,
        recipe,
      };
    } else {
      const model = this.catalogManager.getModelById(appPod.Labels[POD_LABEL_MODEL_ID]);
      opts = {
        connection,
        recipe,
        model,
      };
    }

    // init the recipe
    const podInfo = await this.initApplication(opts);

    // start the pod
    return this.runApplication(podInfo, {
      'recipe-id': recipeId,
      'model-id': modelId,
    });
  }

  async getApplicationPorts(recipeId: string, modelId: string): Promise<number[]> {
    const state = this.#applications.get({ recipeId, modelId });
    if (state) {
      return state.appPorts;
    }
    throw new Error(`Recipe ${recipeId} has no ports available`);
  }

  protected async getApplicationPod(recipeId: string, modelId: string): Promise<PodInfo> {
    const appPod = await this.findPod(recipeId, modelId);
    if (!appPod) {
      throw new Error(`no pod found with recipe Id ${recipeId} and model Id ${modelId}`);
    }
    return appPod;
  }

  protected async hasApplicationPod(recipeId: string, modelId: string): Promise<boolean> {
    const pod = await this.podManager.findPodByLabelsValues({
      LABEL_RECIPE_ID: recipeId,
      LABEL_MODEL_ID: modelId,
    });
    return !!pod;
  }

  protected async findPod(recipeId: string, modelId: string): Promise<PodInfo | undefined> {
    return this.podManager.findPodByLabelsValues({
      [POD_LABEL_RECIPE_ID]: recipeId,
      [POD_LABEL_MODEL_ID]: modelId,
    });
  }

  dispose(): void {
    this.#disposables.forEach(disposable => disposable.dispose());
  }
}
