export class WorkflowGraph {
  constructor() {
    this.nodes = {};
    this._id = 0;
  }

  nextId() {
    return String(++this._id);
  }

  // add(classType, inputs, id?) -> nodeId
  // inputs may mix literal values and [nodeId, slotIndex] links.
  add(classType, inputs = {}, id = null) {
    const nodeId = id || this.nextId();
    this.nodes[nodeId] = { class_type: classType, inputs: { ...inputs } };
    return nodeId;
  }

  link(nodeId, field, fromNodeId, fromSlot = 0) {
    this.nodes[nodeId].inputs[field] = [fromNodeId, fromSlot];
    return this;
  }

  set(nodeId, field, value) {
    this.nodes[nodeId].inputs[field] = value;
    return this;
  }

  toJSON() {
    return this.nodes;
  }
}
