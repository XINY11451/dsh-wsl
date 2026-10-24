/**
 * The `asRoot` switch, shared by every tool that can run privileged.
 *
 * WSL's root needs no password, so the settings switch IS the authorisation:
 * there is nothing else standing between `asRoot: true` and a privileged
 * command. It is refused loudly and never silently downgraded to the user
 * account — a caller that asked for root and got a permission error would look
 * for the cause in the wrong place.
 */
export function assertRootAllowed(config, toolName, asRoot) {
  if (asRoot === true && config.allowRoot !== true) {
    throw new Error(
      `${toolName}: running as root is switched off in this plugin's settings ` +
      '(left sidebar → WSL panel → 管理员模式). Turn it on there if privileged commands are intended.',
    )
  }
}

/** `asRoot` arrives from a model, so its type is checked like any other argument. */
export function checkAsRootArgument(toolName, asRoot) {
  if (asRoot !== undefined && typeof asRoot !== 'boolean') {
    throw new Error(`${toolName}: asRoot must be a boolean`)
  }
}
