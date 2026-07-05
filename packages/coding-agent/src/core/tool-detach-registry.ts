export interface ToolDetachHandle {
	detach(): boolean;
}

export class ToolDetachRegistry {
	private readonly handles = new Set<ToolDetachHandle>();

	register(handle: ToolDetachHandle): () => void {
		this.handles.add(handle);
		return () => this.handles.delete(handle);
	}

	detachRunning(): boolean {
		const handles = [...this.handles].reverse();
		for (const handle of handles) {
			if (handle.detach()) {
				return true;
			}
		}
		return false;
	}

	hasRunning(): boolean {
		return this.handles.size > 0;
	}
}
