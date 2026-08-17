<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Mods</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Install and manage mods across the client profile, launcher, and managed servers.
        </p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" :disabled="!stateReady" @click="refetchInstalled()">
          <RefreshCw /> Refresh
        </Button>
        <Dialog v-model:open="installDialogOpen">
          <DialogTrigger as-child>
            <Button :disabled="!targetReady">
              <Download /> Install mods
            </Button>
          </DialogTrigger>
          <DialogContent class="max-w-3xl max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Install mods from Modrinth</DialogTitle>
              <DialogDescription>
                Search and select mods to install. Results are filtered by Minecraft version, loader, and project type.
              </DialogDescription>
            </DialogHeader>
            <div v-if="selectedModSummaries.length" class="shrink-0 rounded-lg border bg-muted/30 p-3">
              <div class="flex items-center justify-between gap-3">
                <p class="text-xs font-medium">Selected mods</p>
                <span class="text-[11px] text-muted-foreground">{{ selectedModSummaries.length }} / {{ installSelectionLimit }}</span>
              </div>
              <div class="mt-2 flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
                <Badge v-for="item in selectedModSummaries" :key="item.slug" variant="outline" class="max-w-full">
                  <span class="truncate">{{ item.title }}</span>
                </Badge>
              </div>
            </div>
            <div class="flex-1 overflow-hidden flex flex-col gap-4 min-h-0">
              <div class="flex gap-2">
                <Input v-model="searchText" placeholder="Search mods..." @keyup.enter="searchMods" />
                <Button :disabled="!canSearch || searchPending" @click="searchMods">
                  <Search /> Search
                </Button>
              </div>
              <div v-if="searchResults?.items.length" class="flex-1 overflow-auto space-y-2 pr-1 min-h-0">
                <div
                  v-for="item in searchResults.items"
                  :key="item.projectId"
                  class="block cursor-pointer rounded-md border p-3 transition-colors hover:bg-accent"
                  :class="{ 'border-primary bg-primary/5': selectedSlugs.includes(item.slug) }"
                  @click="toggleSelected(item)"
                >
                  <div class="flex items-start gap-3">
                    <Checkbox
                      :model-value="selectedSlugs.includes(item.slug)"
                      :disabled="!selectedSlugs.includes(item.slug) && (installSelectionAtLimit || !hasAvailableDestination(item))"
                      class="mt-1"
                      @click.stop
                      @update:model-value="toggleSelected(item)"
                    />
                    <img v-if="item.iconUrl" :src="item.iconUrl" alt="" class="size-10 rounded-md" />
                    <div class="min-w-0 flex-1">
                      <p class="font-medium">{{ item.title }}</p>
                      <p class="line-clamp-2 text-xs text-muted-foreground">{{ item.description }}</p>
                      <p class="mt-1 text-xs text-muted-foreground">
                        {{ item.author }} · {{ formatDownloads(item.downloads) }}
                      </p>
                      <p v-if="!hasAvailableDestination(item)" class="mt-1 text-xs text-destructive">
                        No compatible client or managed server destination.
                      </p>
                    </div>
                  </div>
                  <div
                    v-if="selectedSlugs.includes(item.slug)"
                    class="mt-3 space-y-3 border-t pt-3 text-xs"
                    @click.stop
                  >
                    <div class="grid gap-3 sm:grid-cols-2">
                      <div class="space-y-3 rounded-lg border bg-background p-3">
                        <div class="flex items-center justify-between gap-3">
                          <div>
                            <p class="font-medium">Client files</p>
                            <p class="text-[11px] text-muted-foreground">
                              Modrinth: {{ item.clientSide ?? 'unknown' }}
                            </p>
                          </div>
                          <Switch
                            :model-value="targetFor(item).clientMode !== 'none'"
                            :disabled="item.clientSide === 'unsupported'"
                            @update:model-value="setClientMode(item, $event ? 'required' : 'none')"
                          />
                        </div>
                        <div
                          v-if="targetFor(item).clientMode !== 'none'"
                          class="flex items-center justify-between gap-3"
                        >
                          <span>Optional in launcher</span>
                          <Switch
                            :model-value="targetFor(item).clientMode === 'optional'"
                            @update:model-value="setClientMode(item, $event ? 'optional' : 'required')"
                          />
                        </div>
                        <div
                          v-if="targetFor(item).clientMode === 'optional'"
                          class="flex items-center justify-between gap-3"
                        >
                          <span>Enabled by default</span>
                          <Switch v-model="targetFor(item).optionalEnabledByDefault" />
                        </div>
                      </div>
                      <div class="space-y-2 rounded-lg border bg-background p-3">
                        <div>
                          <p class="font-medium">Server files</p>
                          <p class="text-[11px] text-muted-foreground">
                            Modrinth: {{ item.serverSide ?? 'unknown' }}
                          </p>
                        </div>
                        <p v-if="!managedServers.length" class="text-muted-foreground">
                          No managed servers for this profile.
                        </p>
                        <label
                          v-for="server in managedServers"
                          :key="server.id!"
                          class="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                        >
                          <span>{{ server.name }}</span>
                          <Switch
                            :model-value="targetFor(item).serverBindingIds.includes(server.id!)"
                            :disabled="item.serverSide === 'unsupported'"
                            @update:model-value="toggleServerTarget(item, server.id!)"
                          />
                        </label>
                      </div>
                    </div>
                    <div
                      v-if="targetFor(item).clientMode === 'optional'"
                      class="grid gap-2 sm:grid-cols-2"
                    >
                      <Input v-model="targetFor(item).optionalName" placeholder="Launcher display name" />
                      <Input
                        v-model="targetFor(item).optionalDescription"
                        placeholder="Optional mod description"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <p v-else-if="searchResults" class="py-8 text-center text-sm text-muted-foreground">No compatible mods found.</p>
              <p v-else class="py-8 text-center text-sm text-muted-foreground">
                Search for mods to install from Modrinth.
              </p>
              <Alert v-if="installSelectionAtLimit" variant="destructive">
                <TriangleAlert class="size-4" />
                <AlertTitle>Selection limit reached</AlertTitle>
                <AlertDescription>
                  At most {{ installSelectionLimit }} mods can be installed in one operation.
                  Remove some selected mods before choosing more.
                </AlertDescription>
              </Alert>
              <Alert v-if="missingDestinationSlugs.length" variant="destructive">
                <TriangleAlert class="size-4" />
                <AlertTitle>Install destination required</AlertTitle>
                <AlertDescription>
                  Choose Client files or Server files for:
                  {{ missingDestinationSlugs.join(', ') }}
                </AlertDescription>
              </Alert>
            </div>
            <DialogFooter class="items-center sm:justify-between">
              <p class="text-xs" :class="installSelectionAtLimit ? 'text-destructive' : 'text-muted-foreground'">
                {{ selectedSlugs.length }} / {{ installSelectionLimit }} selected
              </p>
              <div class="flex flex-wrap justify-end gap-2">
                <Button
                  v-if="selectedSlugs.length"
                  type="button"
                  variant="outline"
                  @click="copyInstallSelection"
                >
                  <Check v-if="selectionCopied" />
                  <Copy v-else />
                  {{ selectionCopied ? 'Copied' : 'Copy list' }}
                </Button>
                <Button
                  v-if="selectedSlugs.length"
                  type="button"
                  variant="ghost"
                  @click="clearInstallSelection"
                >
                  <Trash2 /> Clear selection
                </Button>
                <Button
                  :disabled="!selectedSlugs.length || !selectedTargetsReady"
                  @click="installSelected"
                >
                  <Download /> Install selected ({{ selectedSlugs.length }})
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Mod operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Destinations</CardTitle>
        <CardDescription>
          One profile defines compatibility; each operation can target the client, one or more servers, or both.
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div class="rounded-lg border bg-primary/5 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-semibold">Client profile</p>
              <p class="mt-1 font-mono text-xs text-muted-foreground">{{ profile || 'No profile selected' }}</p>
            </div>
            <Badge variant="secondary">Client & Launcher</Badge>
          </div>
          <p class="mt-3 text-xs text-muted-foreground">
            Required client files and optional launcher mod settings.
          </p>
        </div>
        <div
          v-for="server in managedServers"
          :key="server.id!"
          class="rounded-lg border p-4"
          :class="selectedServerId === server.id ? 'border-primary bg-primary/5' : ''"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">{{ server.name }}</p>
              <p class="mt-1 truncate font-mono text-xs text-muted-foreground">{{ server.serverAddress }}:{{ server.serverPort }}</p>
            </div>
            <Badge :variant="server.deploymentState === 'installed' ? 'secondary' : 'outline'">{{ server.deploymentState }}</Badge>
          </div>
          <Button class="mt-3 px-0" size="sm" variant="link" @click="openServerFiles(server)">
            <FolderOpen /> Open live files
          </Button>
        </div>
        <div v-if="!managedServers.length" class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No managed server destinations exist for this profile.
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="text-base">Target profile</CardTitle>
            <CardDescription class="mt-1">
              Minecraft version and loader follow the built profile unless you unlock them.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            class="cursor-pointer"
            @click="constraintsLocked = !constraintsLocked"
          >
            <Unlock v-if="constraintsLocked" />
            <Lock v-else />
            {{ constraintsLocked ? 'Unlock parameters' : 'Lock to profile' }}
          </Button>
        </div>
      </CardHeader>
      <CardContent class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div>
          <label class="text-xs font-medium" for="mods-profile">Profile</label>
          <Select v-model="profile">
            <SelectTrigger id="mods-profile" class="mt-1 w-full">
              <SelectValue placeholder="No profile selected" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="item in profiles?.items ?? []" :key="item.name" :value="item.name">
                {{ item.title }}<template v-if="item.title !== item.name"> · {{ item.name }}</template>
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="mt-1 text-xs text-muted-foreground">
            Shared by client files and managed server destinations.
          </p>
        </div>
        <div>
          <label class="text-xs font-medium" for="mods-version">Minecraft</label>
          <MinecraftVersionCombobox
            id="mods-version"
            v-model="version"
            class="mt-1"
            :versions="versionCatalog?.items.map((item) => item.id) ?? []"
            :loading="versionsLoading"
            :disabled="constraintsLocked"
          />
        </div>
        <div>
          <label class="text-xs font-medium" for="mods-loader">Loader</label>
          <Select v-model="loader">
            <SelectTrigger id="mods-loader" class="mt-1 w-full" :disabled="constraintsLocked">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="item in loaders"
                :key="item"
                :value="item"
                :disabled="item === 'VANILLA'"
              >
                {{ item }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex items-center gap-2 sm:col-span-2 xl:col-span-3">
          <Badge :variant="constraintsLocked ? 'secondary' : 'outline'">
            <Lock v-if="constraintsLocked" />
            <Unlock v-else />
            {{ constraintsLocked ? 'Using profile parameters' : 'Manual override' }}
          </Badge>
          <p v-if="selectedProfile?.loader === 'VANILLA'" class="text-xs text-muted-foreground">
            Vanilla profiles do not support mod operations. Unlock and choose a mod loader to override.
          </p>
          <p
            v-else-if="selectedProfile && (!selectedProfile.minecraftVersion || !selectedProfile.loader)"
            class="text-xs text-muted-foreground"
          >
            Profile parameters could not be detected. Unlock them to continue.
          </p>
        </div>
      </CardContent>
    </Card>

    <ModpackImportCard
      :installation-id="installationId"
      :profile="profile"
      :minecraft-version="version"
      :loader="loader"
      :servers="managedServers"
      :disabled="!targetReady"
      @job="attachJob"
      @error="childError = $event"
    />

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Managed server mods</CardTitle>
        <CardDescription>
          Live JAR files currently present in each managed server's mods directory.
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3 lg:grid-cols-2">
        <div
          v-for="server in serverModInventories"
          :key="server.bindingId"
          class="min-w-0 rounded-lg border p-4"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">{{ server.serverName }}</p>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ server.error ? server.error : `${server.items.length} live mod${server.items.length === 1 ? '' : 's'}` }}
              </p>
            </div>
            <Badge :variant="server.connected ? 'secondary' : 'destructive'">
              {{ server.connected ? 'Live' : 'Offline' }}
            </Badge>
          </div>
          <div v-if="server.items.length" class="mt-3 max-h-40 space-y-1 overflow-auto rounded-md bg-muted/35 p-2">
            <div v-for="mod in server.items" :key="mod.path" class="flex items-center justify-between gap-3 px-2 py-1 text-xs">
              <span class="min-w-0 truncate font-mono">{{ mod.path.split('/').at(-1) }}</span>
              <span class="shrink-0 text-muted-foreground">{{ formatBytes(mod.size ?? 0) }}</span>
            </div>
          </div>
          <Button class="mt-3 px-0" size="sm" variant="link" @click="openServerMods(server.bindingId)">
            <FolderOpen /> Open live mods folder
          </Button>
        </div>
        <div v-if="!serverModInventories.length" class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No managed server mod inventories are available.
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="text-base">Client profile mods</CardTitle>
            <CardDescription>
              Manage client-side files and optionally mirror compatible projects to managed servers.
            </CardDescription>
          </div>
          <div class="flex items-center gap-2">
            <Input
              v-model="installedSearch"
              placeholder="Filter mods..."
              class="w-48"
            />
            <Button
              v-if="installed?.items.length"
              size="sm"
              variant="ghost"
              @click="toggleAllInstalled"
            >
              {{ allInstalledSelected ? 'Clear' : 'Select all' }}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent class="space-y-2">
        <div
          v-if="selectedInstalledItems.length"
          class="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur"
        >
          <Badge variant="secondary">{{ selectedInstalledItems.length }} selected</Badge>
          <Button size="sm" variant="outline" @click="runBulk('enable')">
            <Power /> Enable
          </Button>
          <Button size="sm" variant="outline" @click="runBulk('disable')">
            <Power /> Disable
          </Button>
          <Button
            size="sm"
            variant="outline"
            :disabled="!bulkUpdateReady"
            @click="runBulk('update')"
          >
            <RefreshCw /> Update
          </Button>
          <Button
            size="sm"
            variant="outline"
            :disabled="!bulkServerMods.length || !managedServers.length || !targetReady"
            @click="openServerInstall(selectedInstalledItems)"
          >
            <ServerCog /> Add to server ({{ bulkServerMods.length }})
          </Button>
          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button size="sm" variant="destructive">
                <Trash2 /> Remove
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Remove {{ selectedInstalledItems.length }} selected mods?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Every selected file will be deleted permanently. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div class="space-y-3 py-3">
                <label class="flex items-center gap-2 text-sm">
                  <Checkbox v-model="bulkRemoveFromServer" />
                  Also remove from managed servers
                </label>
                <label class="flex items-center gap-2 text-sm" :class="{ 'text-muted-foreground': !bulkRemoveFromServer }">
                  <Checkbox v-model="bulkRemoveUnusedDependencies" :disabled="!bulkRemoveFromServer" />
                  Remove dependencies no longer used by other server mods
                </label>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="runBulk('remove')">
                  Delete permanently
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <div class="h-[60vh] max-h-[32rem] overflow-auto pr-1 md:h-[32rem]">
          <p v-if="!stateReady" class="grid h-full place-items-center text-center text-sm text-muted-foreground">Select a complete target profile.</p>
          <p v-else-if="installedFetching" class="grid h-full place-items-center text-center text-sm text-muted-foreground">Hashing mod files…</p>
          <p v-else-if="!installed?.items.length" class="grid h-full place-items-center text-center text-sm text-muted-foreground">No mod JARs detected.</p>
          <p v-else-if="!filteredInstalledItems.length" class="grid h-full place-items-center text-center text-sm text-muted-foreground">
            No mods match your filter.
          </p>
          <div v-else class="space-y-2">
            <div
              v-for="item in filteredInstalledItems"
              :key="item.filename"
              class="cursor-pointer rounded-md border p-3 transition-colors hover:bg-accent"
              :class="{ 'border-primary bg-primary/5': selectedInstalledFilenames.includes(item.filename) }"
              @click="toggleInstalledSelection(item.filename)"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="flex min-w-0 items-start gap-3">
                  <Checkbox
                    :model-value="selectedInstalledFilenames.includes(item.filename)"
                    class="mt-1"
                    @click.stop
                    @update:model-value="toggleInstalledSelection(item.filename)"
                  />
                  <div class="min-w-0">
                    <p class="truncate text-sm font-medium">{{ item.filename }}</p>
                    <p class="mt-1 text-xs text-muted-foreground">
                      {{ item.versionName ?? 'Unknown to Modrinth' }} · {{ formatBytes(item.size) }}
                    </p>
                  </div>
                </div>
                <Badge :variant="item.disabled ? 'outline' : 'secondary'">
                  {{ item.disabled ? 'Disabled' : 'Enabled' }}
                </Badge>
              </div>
              <div class="mt-3 inline-flex max-w-full flex-wrap gap-2">
                <Button size="sm" variant="outline" @click.stop="toggleMod(item)">
                  <Power /> {{ item.disabled ? 'Enable' : 'Disable' }}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="!item.projectId || !targetReady"
                  @click.stop="updateMod(item)"
                >
                  <RefreshCw /> Update
                </Button>
                <Button
                  v-if="item.projectId"
                  size="sm"
                  variant="outline"
                  @click.stop="openOptionalDialog(item)"
                >
                  <Settings /> Make optional
                </Button>
                <Button
                  v-if="canInstallOnServer(item)"
                  size="sm"
                  variant="outline"
                  :disabled="!managedServers.length || !targetReady"
                  @click.stop="openServerInstall([item])"
                >
                  <ServerCog /> Add to server
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger as-child>
                    <Button size="sm" variant="destructive" @click.stop><Trash2 /> Remove</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {{ item.filename }}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The file will be deleted permanently. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div class="space-y-3 py-3">
                      <label class="flex items-center gap-2 text-sm">
                        <Checkbox v-model="item._removeFromServer" />
                        Also remove from managed servers
                      </label>
                      <label class="flex items-center gap-2 text-sm" :class="{ 'text-muted-foreground': !item._removeFromServer }">
                        <Checkbox v-model="item._removeUnusedDependencies" :disabled="!item._removeFromServer" />
                        Remove dependencies no longer used by other server mods
                      </label>
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction @click="removeMod(item)">Delete permanently</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <OptionalModsCard
      :installation-id="installationId"
      :profile="profile"
      :disabled="!stateReady"
      @job="attachJob"
      @error="childError = $event"
    />

    <Dialog v-model:open="optionalDialogOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make mod optional</DialogTitle>
          <DialogDescription>
            Configure this mod as optional in the launcher. Users will be able to enable or disable it.
          </DialogDescription>
        </DialogHeader>
        <div v-if="optionalDialogMod" class="space-y-4">
          <div>
            <label class="text-xs font-medium">Display name</label>
            <Input v-model="optionalForm.name" class="mt-1" placeholder="Mod display name" />
          </div>
          <div>
            <label class="text-xs font-medium">Description</label>
            <textarea
              v-model="optionalForm.description"
              rows="2"
              class="mt-1 flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              placeholder="Describe what this mod does"
            />
          </div>
          <div>
            <label class="text-xs font-medium">Category</label>
            <Input v-model="optionalForm.category" class="mt-1" placeholder="Mods" />
          </div>
          <label class="flex items-center gap-2 text-sm">
            <Checkbox v-model="optionalForm.enabledByDefault" />
            Enabled by default
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="optionalDialogOpen = false">Cancel</Button>
          <Button :disabled="!optionalForm.name.trim()" @click="convertToOptional">
            Make optional
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="serverInstallDialogOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add mods to server</DialogTitle>
          <DialogDescription>
            Select managed servers. A new server pack version will be published for every target.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="rounded-md border p-3 text-sm">
            {{ serverInstallMods.length }} compatible mod{{ serverInstallMods.length === 1 ? '' : 's' }} selected
          </div>
          <p v-if="!managedServers.length" class="text-sm text-muted-foreground">
            No managed servers are configured for this profile.
          </p>
          <label
            v-for="server in managedServers"
            :key="server.id!"
            class="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
          >
            <span>{{ server.name }}</span>
            <Checkbox
              :model-value="serverInstallBindingIds.includes(server.id!)"
              @update:model-value="toggleServerInstallBinding(server.id!)"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="serverInstallDialogOpen = false">Cancel</Button>
          <Button
            :disabled="!serverInstallMods.length || !serverInstallBindingIds.length"
            @click="installModsOnServers"
          >
            <ServerCog /> Add to selected servers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <JobProgressNotifier :job="activeJob" title="Mod operation" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import MinecraftVersionCombobox from '@/components/clients/MinecraftVersionCombobox.vue'
import JobProgressNotifier from '@/components/jobs/JobProgressNotifier.vue'
import ModpackImportCard from '@/components/mods/ModpackImportCard.vue'
import OptionalModsCard from '@/components/mods/OptionalModsCard.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useClientProfiles } from '@/composables/useClientProfiles'
import { useLaunchServerStore } from '@/stores/launchserver'
import { useProfilesStore } from '@/stores/profiles'
import { serverBindingKey, useServersStore } from '@/stores/servers'
import { registerJobNotification } from '@/stores/job-notifications'
import type {
  ClientModMode, InstalledMod, JobRecord, MinecraftLoader,
  MinecraftVersionCatalog, ModInstallSelection, ModrinthProject,
  ProfileServerBinding,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  Check, Copy, Download, FolderOpen, Lock, Power, RefreshCw, Search, ServerCog, Settings, Trash2,
  TriangleAlert, Unlock,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

const loaders = ['VANILLA', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'] as const
const installSelectionLimit = 200
const queryClient = useQueryClient()
const router = useRouter()
const { launchServerId: installationId } = storeToRefs(useLaunchServerStore())
const { selectedProfileName: profile } = storeToRefs(useProfilesStore())
const serversStore = useServersStore()
const { selectedBindingKey } = storeToRefs(serversStore)
const version = ref('')
const loader = ref<MinecraftLoader>('FABRIC')
const constraintsLocked = ref(true)
const searchText = ref('')
const installedSearch = ref('')
const selectedSlugs = ref<string[]>([])
const selectionCopied = ref(false)
const selectedInstalledFilenames = ref<string[]>([])
const childError = ref<Error | null>(null)
const installDialogOpen = ref(false)
const bulkRemoveFromServer = ref(false)
const bulkRemoveUnusedDependencies = ref(false)
const optionalDialogOpen = ref(false)
type InstalledModItem = InstalledMod & {
  _removeFromServer?: boolean
  _removeUnusedDependencies?: boolean
}
interface ServerModInventory {
  bindingId: string
  serverName: string
  connected: boolean
  error: string | null
  items: Array<{ path: string; type: string; size: number | null; modifiedAt: string }>
}
const optionalDialogMod = ref<InstalledModItem | null>(null)
const serverInstallDialogOpen = ref(false)
const serverInstallMods = ref<InstalledModItem[]>([])
const serverInstallBindingIds = ref<string[]>([])
const optionalForm = reactive({
  name: '',
  description: '',
  category: 'Mods',
  enabledByDefault: false,
})
const selectionTargets = reactive<Record<string, ModInstallSelection>>({})
const selectionNames = reactive<Record<string, string>>({})
let selectionCopiedTimer: ReturnType<typeof setTimeout> | null = null
const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => installationId.value,
  [
    'gravit.mods.install',
    'gravit.mods.server.install',
    'gravit.mods.update',
    'gravit.mods.toggle',
    'gravit.mods.remove',
    'gravit.mods.bulk',
    'gravit.mods.optional.update',
    'gravit.mods.optional.remove',
    'gravit.mods.modpack.import',
  ],
)
watch(installationId, () => {
  selectedSlugs.value = []
  selectedInstalledFilenames.value = []
  Object.keys(selectionTargets).forEach((key) => delete selectionTargets[key])
  Object.keys(selectionNames).forEach((key) => delete selectionNames[key])
  version.value = ''
  loader.value = 'FABRIC'
  constraintsLocked.value = true
})

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}
const postJob = (url: string, body: Record<string, unknown>) =>
  getJson<JobRecord>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const {
  data: versionCatalog,
  error: versionsError,
  isPending: versionsLoading,
} = useQuery({
  queryKey: ['minecraft-versions'],
  queryFn: () => getJson<MinecraftVersionCatalog>('/api/clients/minecraft-versions'),
  staleTime: 6 * 60 * 60 * 1000,
})
const { data: profiles, error: profilesError } = useClientProfiles()
const selectedProfile = computed(
  () => profiles.value?.items.find((item) => item.name === profile.value) ?? null,
)
const applyProfileParameters = () => {
  const selected = selectedProfile.value
  if (!selected) return
  version.value = selected.minecraftVersion ?? ''
  loader.value = selected.loader ?? 'FABRIC'
}
watch(profiles, () => {
  if (constraintsLocked.value) applyProfileParameters()
}, { immediate: true })
watch(profile, () => {
  selectedSlugs.value = []
  selectedInstalledFilenames.value = []
  Object.keys(selectionTargets).forEach((key) => delete selectionTargets[key])
  Object.keys(selectionNames).forEach((key) => delete selectionNames[key])
  if (constraintsLocked.value) applyProfileParameters()
})
const selectionStorageKey = computed(
  () => `gravit-panel:mods:selection:${installationId.value}:${profile.value}`,
)
const clearInstallSelection = () => {
  selectedSlugs.value = []
  Object.keys(selectionTargets).forEach((key) => delete selectionTargets[key])
  Object.keys(selectionNames).forEach((key) => delete selectionNames[key])
  selectionCopied.value = false
  localStorage.removeItem(selectionStorageKey.value)
}
const restoreInstallSelection = () => {
  selectedSlugs.value = []
  Object.keys(selectionTargets).forEach((key) => delete selectionTargets[key])
  Object.keys(selectionNames).forEach((key) => delete selectionNames[key])
  try {
    const raw = localStorage.getItem(selectionStorageKey.value)
    if (!raw) return
    const stored = JSON.parse(raw) as {
      slugs?: unknown
      targets?: Record<string, ModInstallSelection>
      names?: Record<string, string>
    }
    if (!Array.isArray(stored.slugs)) return
    selectedSlugs.value = [...new Set(stored.slugs.filter(
      (slug): slug is string => typeof slug === 'string',
    ))]
    for (const slug of selectedSlugs.value) {
      const target = stored.targets?.[slug]
      if (target) selectionTargets[slug] = target
      const name = stored.names?.[slug]
      if (name) selectionNames[slug] = name
    }
  } catch {
    localStorage.removeItem(selectionStorageKey.value)
  }
}
watch([installationId, profile], restoreInstallSelection, { immediate: true })
watch([selectedSlugs, selectionTargets, selectionNames], () => {
  const targets = Object.fromEntries(
    selectedSlugs.value.flatMap((slug) => selectionTargets[slug]
      ? [[slug, selectionTargets[slug]]]
      : []),
  )
  localStorage.setItem(selectionStorageKey.value, JSON.stringify({
    slugs: selectedSlugs.value,
    targets,
    names: { ...selectionNames },
  }))
}, { deep: true })
watch(constraintsLocked, (locked) => {
  if (locked) applyProfileParameters()
})
watch(versionCatalog, (catalog) => {
  if (!constraintsLocked.value && !version.value && catalog?.latestRelease) {
    version.value = catalog.latestRelease
  }
}, { immediate: true })

const stateReady = computed(
  () => Boolean(installationId.value && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile.value)),
)
const targetReady = computed(
  () => Boolean(stateReady.value && version.value && loader.value !== 'VANILLA'),
)
const {
  data: installed, error: installedError, isFetching: installedFetching,
  refetch: refetchInstalled,
} = useQuery({
  queryKey: computed(() => ['installed-mods', installationId.value, profile.value]),
  queryFn: () => getJson<{ items: InstalledModItem[] }>(
    `/api/mods/installed?installationId=${encodeURIComponent(installationId.value)}&profile=${encodeURIComponent(profile.value)}`,
  ),
  enabled: stateReady,
  retry: false,
})
const { data: serverBindings, error: serverBindingsError } = useQuery({
  queryKey: computed(() => ['server-bindings', installationId.value, profile.value]),
  queryFn: () => getJson<{ items: ProfileServerBinding[] }>(
    `/api/servers/profiles/${encodeURIComponent(profile.value)}/bindings` +
    `?installationId=${encodeURIComponent(installationId.value)}`,
  ),
  enabled: stateReady,
})
const managedServers = computed(
  () => serverBindings.value?.items.filter((item) => item.managed && item.id) ?? [],
)
const { data: serverMods, error: serverModsError } = useQuery({
  queryKey: computed(() => ['server-mod-inventories', installationId.value, profile.value]),
  queryFn: () => getJson<{ items: ServerModInventory[] }>(
    `/api/servers/profiles/${encodeURIComponent(profile.value)}/mods` +
    `?installationId=${encodeURIComponent(installationId.value)}`,
  ),
  enabled: stateReady,
  retry: false,
})
const serverModInventories = computed(() => serverMods.value?.items ?? [])
const selectedServerId = computed(
  () => managedServers.value.find((server) => serverBindingKey(server) === selectedBindingKey.value)?.id ?? null,
)
const openServerFiles = (server: ProfileServerBinding) => {
  selectedBindingKey.value = serverBindingKey(server)
  void router.push('/panel/server/files')
}
const openServerMods = (bindingId: string) => {
  const server = managedServers.value.find((item) => item.id === bindingId)
  if (server) selectedBindingKey.value = serverBindingKey(server)
  void router.push('/panel/server/files?path=mods')
}
const filteredInstalledItems = computed(() => {
  const items = installed.value?.items ?? []
  const search = installedSearch.value.trim().toLowerCase()
  if (!search) return items
  return items.filter((item) =>
    item.filename.toLowerCase().includes(search) ||
    (item.versionName?.toLowerCase().includes(search) ?? false),
  )
})
const selectedInstalledItems = computed(
  () => installed.value?.items.filter(
    (item) => selectedInstalledFilenames.value.includes(item.filename),
  ) ?? [],
)
const allInstalledSelected = computed(
  () => Boolean(
    installed.value?.items.length &&
    selectedInstalledItems.value.length === installed.value.items.length,
  ),
)
const bulkUpdateReady = computed(
  () => Boolean(
    targetReady.value &&
    selectedInstalledItems.value.length &&
    selectedInstalledItems.value.every((item) => item.projectId),
  ),
)
const canInstallOnServer = (item: InstalledMod) => Boolean(
  item.slug && (item.serverSide === 'required' || item.serverSide === 'optional'),
)
const bulkServerMods = computed(() => selectedInstalledItems.value.filter(canInstallOnServer))
watch(installed, (value) => {
  const available = new Set(value?.items.map((item) => item.filename) ?? [])
  selectedInstalledFilenames.value = selectedInstalledFilenames.value.filter(
    (filename) => available.has(filename),
  )
})

const {
  data: searchResults, error: searchError, isPending: searchPending, mutate: runSearch,
} = useMutation({
  mutationFn: () => getJson<{ items: ModrinthProject[] }>(
    `/api/mods/search?query=${encodeURIComponent(searchText.value)}&minecraftVersion=${encodeURIComponent(version.value)}&loader=${loader.value}`,
  ),
})
const selectedModSummaries = computed(() => selectedSlugs.value.map((slug) => ({
  slug,
  title: selectionNames[slug] || searchResults.value?.items.find((item) => item.slug === slug)?.title || slug,
})))
const canSearch = computed(() => Boolean(searchText.value.trim() && targetReady.value))
const searchMods = () => { if (canSearch.value) runSearch() }
const defaultTargets = (item: ModrinthProject): ModInstallSelection => ({
  slug: item.slug,
  clientMode:
    item.clientSide === 'required'
      ? 'required'
      : item.clientSide === 'optional'
        ? 'optional'
        : 'none',
  serverBindingIds:
    item.serverSide === 'required'
      ? managedServers.value.flatMap((server) => server.id ? [server.id] : [])
      : [],
  optionalEnabledByDefault: false,
  optionalName: item.title,
  optionalDescription: item.description,
})
const targetFor = (item: ModrinthProject) =>
  selectionTargets[item.slug] ?? (selectionTargets[item.slug] = defaultTargets(item))
const hasAvailableDestination = (item: ModrinthProject) =>
  item.clientSide !== 'unsupported' ||
  (item.serverSide !== 'unsupported' && managedServers.value.length > 0)
const installSelectionAtLimit = computed(
  () => selectedSlugs.value.length >= installSelectionLimit,
)
const missingDestinationSlugs = computed(() => selectedSlugs.value.filter((slug) => {
  const target = selectionTargets[slug]
  return !target || (target.clientMode === 'none' && target.serverBindingIds.length === 0)
}))
const toggleSelected = (item: ModrinthProject) => {
  if (selectedSlugs.value.includes(item.slug)) {
    selectedSlugs.value = selectedSlugs.value.filter((slug) => slug !== item.slug)
    delete selectionTargets[item.slug]
    delete selectionNames[item.slug]
  } else {
    if (installSelectionAtLimit.value || !hasAvailableDestination(item)) return
    selectedSlugs.value = [...selectedSlugs.value, item.slug]
    selectionTargets[item.slug] = defaultTargets(item)
    selectionNames[item.slug] = item.title
  }
}
const setClientMode = (item: ModrinthProject, mode: ClientModMode) => {
  targetFor(item).clientMode = mode
}
const toggleServerTarget = (item: ModrinthProject, bindingId: string) => {
  const target = targetFor(item)
  target.serverBindingIds = target.serverBindingIds.includes(bindingId)
    ? target.serverBindingIds.filter((id) => id !== bindingId)
    : [...target.serverBindingIds, bindingId]
}
const selectedTargetsReady = computed(
  () =>
    selectedSlugs.value.length > 0 &&
    selectedSlugs.value.length <= installSelectionLimit &&
    missingDestinationSlugs.value.length === 0 &&
    selectedSlugs.value.every((slug) => {
      const target = selectionTargets[slug]
      return Boolean(
        target &&
        (target.clientMode !== 'none' || target.serverBindingIds.length > 0),
      )
    }),
)
const copyInstallSelection = async () => {
  const targets = Object.fromEntries(
    selectedSlugs.value.flatMap((slug) => selectionTargets[slug]
      ? [[slug, selectionTargets[slug]]]
      : []),
  )
  try {
    await navigator.clipboard.writeText(JSON.stringify({
      slugs: selectedSlugs.value,
      targets,
    }, null, 2))
    selectionCopied.value = true
    if (selectionCopiedTimer) clearTimeout(selectionCopiedTimer)
    selectionCopiedTimer = setTimeout(() => { selectionCopied.value = false }, 2_000)
  } catch {
    childError.value = new Error('Unable to copy the selected mod list.')
  }
}

const {
  mutate: runOperation, error: operationError,
} = useMutation({
  mutationFn: ({ url, body }: { url: string; body: Record<string, unknown> }) => postJob(url, body),
  onSuccess: attachJob,
})
const commonBody = () => ({
  installationId: installationId.value,
  profile: profile.value,
})
const installSelected = () => {
  runOperation({
    url: '/api/mods/install',
    body: {
      ...commonBody(),
      minecraftVersion: version.value,
      loader: loader.value,
      slugs: selectedSlugs.value,
      selections: selectedSlugs.value.map((slug) => selectionTargets[slug]!),
    },
  }, {
    onSuccess: (job) => {
      registerJobNotification(job, 'Mod installation', (finished) => {
        if (finished.status === 'succeeded') clearInstallSelection()
      })
    },
  })
  installDialogOpen.value = false
}
const toggleMod = (item: InstalledMod) => runOperation({
  url: '/api/mods/toggle',
  body: { ...commonBody(), filename: item.filename, enabled: item.disabled },
})
const updateMod = (item: InstalledMod) => runOperation({
  url: '/api/mods/update',
  body: {
    ...commonBody(),
    filename: item.filename,
    minecraftVersion: version.value,
    loader: loader.value,
  },
})
const removeMod = (item: InstalledModItem) => runOperation({
  url: '/api/mods/remove',
  body: {
    ...commonBody(),
    filename: item.filename,
    confirmRemoval: true,
    removeFromServer: item._removeFromServer ?? false,
    removeUnusedDependencies: item._removeFromServer
      ? item._removeUnusedDependencies ?? false
      : false,
  },
})
const openOptionalDialog = (item: InstalledMod) => {
  optionalDialogMod.value = item
  optionalForm.name = item.name ?? item.filename.replace(/\.jar(?:\.disabled)?$/, '')
  optionalForm.description = item.description ?? ''
  optionalForm.category = 'Mods'
  optionalForm.enabledByDefault = false
  optionalDialogOpen.value = true
}
const convertToOptional = () => {
  if (!optionalDialogMod.value?.projectId) return
  runOperation({
    url: '/api/mods/optional/update',
    body: {
      ...commonBody(),
      projectId: optionalDialogMod.value.projectId,
      filename: optionalDialogMod.value.filename,
      name: optionalForm.name.trim(),
      description: optionalForm.description.trim(),
      category: optionalForm.category.trim() || 'Mods',
      enabledByDefault: optionalForm.enabledByDefault,
    },
  })
  optionalDialogOpen.value = false
}
const openServerInstall = (items: InstalledModItem[]) => {
  const projects = new Map<string, InstalledModItem>()
  for (const item of items) {
    if (canInstallOnServer(item) && item.slug) projects.set(item.slug, item)
  }
  serverInstallMods.value = [...projects.values()]
  serverInstallBindingIds.value = managedServers.value.flatMap((server) => server.id ? [server.id] : [])
  serverInstallDialogOpen.value = true
}
const toggleServerInstallBinding = (bindingId: string) => {
  serverInstallBindingIds.value = serverInstallBindingIds.value.includes(bindingId)
    ? serverInstallBindingIds.value.filter((id) => id !== bindingId)
    : [...serverInstallBindingIds.value, bindingId]
}
const installModsOnServers = () => {
  const slugs = serverInstallMods.value.flatMap((item) => item.slug ? [item.slug] : [])
  if (!slugs.length || !serverInstallBindingIds.value.length) return
  runOperation({
    url: '/api/mods/server/install',
    body: {
      ...commonBody(),
      minecraftVersion: version.value,
      loader: loader.value,
      slugs,
      serverBindingIds: serverInstallBindingIds.value,
    },
  })
  serverInstallDialogOpen.value = false
}
const toggleInstalledSelection = (filename: string) => {
  selectedInstalledFilenames.value = selectedInstalledFilenames.value.includes(filename)
    ? selectedInstalledFilenames.value.filter((item) => item !== filename)
    : [...selectedInstalledFilenames.value, filename]
}
const toggleAllInstalled = () => {
  selectedInstalledFilenames.value = allInstalledSelected.value
    ? []
    : installed.value?.items.map((item) => item.filename) ?? []
}
const runBulk = (action: 'enable' | 'disable' | 'update' | 'remove') => {
  if (!selectedInstalledFilenames.value.length) return
  runOperation({
    url: '/api/mods/bulk',
    body: {
      ...commonBody(),
      filenames: selectedInstalledFilenames.value,
      action,
      ...(action === 'update'
        ? { minecraftVersion: version.value, loader: loader.value }
        : {}),
      ...(action === 'remove'
        ? {
            confirmRemoval: true,
            removeFromServer: bulkRemoveFromServer.value,
            removeUnusedDependencies: bulkRemoveFromServer.value && bulkRemoveUnusedDependencies.value,
          }
        : {}),
    },
  })
}
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  const isModUpdate = job.type === 'gravit.mods.update' ||
    (job.type === 'gravit.mods.bulk' && job.input.action === 'update')
  if (job.status === 'succeeded' && (job.type === 'gravit.mods.install' || isModUpdate)) {
    clearInstallSelection()
  }
  if (job.status === 'succeeded') selectedInstalledFilenames.value = []
  await queryClient.invalidateQueries({
    queryKey: ['installed-mods', installationId.value, profile.value],
  })
  await queryClient.invalidateQueries({ queryKey: ['server-bindings'] })
  await queryClient.invalidateQueries({ queryKey: ['server-mod-inventories'] })
  await queryClient.invalidateQueries({
    queryKey: ['optional-mods', installationId.value, profile.value],
  })
}
const pageError = computed(
  () => (
    searchError.value ||
    installedError.value ||
    operationError.value ||
    versionsError.value ||
    profilesError.value ||
    serverBindingsError.value ||
    serverModsError.value ||
    activeJobError.value
    || childError.value
  ) as Error | null,
)
const formatBytes = (value: number) =>
  value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(value / 1024)} KiB`
const formatDownloads = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value)
</script>
