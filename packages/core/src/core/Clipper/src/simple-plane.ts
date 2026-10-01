import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { Hideable, Disposable, Event, World } from "../../Types";
import { Components } from "../../Components";
import { Clipper } from "..";

/**
 * Each of the clipping planes created by the clipper.
 */
export class SimplePlane implements Disposable, Hideable {
  /** Event that fires when the user starts dragging a clipping plane. */
  readonly onDraggingStarted = new Event();

  /** Event that fires when the user stops dragging a clipping plane. */
  readonly onDraggingEnded = new Event();

  /** {@link Disposable.onDisposed} */
  readonly onDisposed = new Event();

  /**
   * The normal vector of the clipping plane.
   */
  readonly normal: THREE.Vector3;

  /**
   * The origin point of the clipping plane.
   */
  readonly origin: THREE.Vector3;

  /**
   * The THREE.js Plane object representing the clipping plane.
   */
  readonly three = new THREE.Plane();

  /** The components instance to which this plane belongs. */
  components: Components;

  /** The world instance to which this plane belongs. */
  world: World;

  /** A custom string to identify what this plane is used for. */
  type = "default";

  private _title: string = "Clipping Plane";
  set title(value: string) {
    this._title = value;
    this.notifyManager();
  }

  get title() {
    return this._title;
  }

  protected readonly _helper: THREE.Object3D;

  protected _visible = true;

  protected _enabled = true;

  private _controlsActive = false;

  private readonly _arrowBoundBox = new THREE.Mesh();

  /** Distance from the plane to each arrow of its handle, in gizmo units. */
  private static readonly axisReach = 0.15;

  /** Length of the stock translate arrow head, in gizmo units. */
  private static readonly arrowLength = 0.1;

  private readonly _planeMesh: THREE.Mesh;

  private readonly _controls: TransformControls;

  private readonly _hiddenMaterial = new THREE.MeshBasicMaterial({
    visible: false,
  });

  private _sizeMultiplier = 5;

  private _autoScale = true;

  get autoScale() {
    return this._autoScale;
  }

  set autoScale(value: boolean) {
    this._autoScale = value;
    if (value) {
      this.updateScale();
    }
  }

  /**
   * Getter for the enabled state of the clipping plane.
   * @returns {boolean} The current enabled state.
   */
  get enabled() {
    return this._enabled;
  }

  /**
   * Setter for the enabled state of the clipping plane.
   * Updates the clipping plane state in the renderer and throws an error if no renderer is found.
   * @param {boolean} state - The new enabled state.
   */
  set enabled(state: boolean) {
    if (this.world.isDisposing) {
      return;
    }
    if (!this.world.renderer) {
      throw new Error("No renderer found for clipping plane!");
    }

    this._enabled = state;

    if (state) {
      this.visible = this._visibilityBeforeDisabled;
    } else {
      this._visibilityBeforeDisabled = this.visible;
      this.visible = false;
    }

    // Read the Clipper's `localClippingPlanes` flag at use time so
    // toggling enabled→disabled→enabled preserves whichever mode the
    // Clipper is in. Without this, the flag would default to
    // `undefined` on every re-enable and the plane would silently
    // pop back into the renderer's global clipping list.
    const clipper = this.components.get(Clipper);
    this.world.renderer.setPlane(
      state,
      this.three,
      clipper.localClippingPlanes,
    );
    this.notifyManager();
  }

  private _visibilityBeforeDisabled = true;

  /** {@link Hideable.visible } */
  get visible() {
    return this._visible;
  }

  /** {@link Hideable.visible } */
  set visible(state: boolean) {
    this._visible = state;
    this._controls.getHelper().visible = state;
    this._helper.visible = state;
    this.toggleControls(state);
    this.notifyManager();
  }

  /** The meshes used for raycasting */
  get meshes(): THREE.Mesh[] {
    return [this._planeMesh, this._arrowBoundBox];
  }

  /** The material of the clipping plane representation. */
  get planeMaterial() {
    return this._planeMesh.material;
  }

  /** The material of the clipping plane representation. */
  set planeMaterial(material: THREE.Material | THREE.Material[]) {
    this._planeMesh.material = material;
  }

  /** The size of the clipping plane representation. */
  get size() {
    return this._sizeMultiplier;
  }

  /** Sets the size of the clipping plane representation. */
  set size(size: number) {
    this._sizeMultiplier = size;
    if (this.autoScale) {
      this.updateScale();
    } else {
      this._planeMesh.scale.set(size, size, size);
    }
  }

  /**
   * Getter for the helper object of the clipping plane.
   * The helper object is a THREE.Object3D that contains the clipping plane mesh and other related objects.
   * It is used for positioning, rotating, and scaling the clipping plane in the 3D scene.
   *
   * @returns {THREE.Object3D} The helper object of the clipping plane.
   */
  get helper() {
    return this._helper;
  }

  /**
   * Getter for the transform controls of the clipping plane.
   * The controls allow interactive manipulation (translation, rotation, etc.) of the clipping plane.
   *
   * @returns {TransformControls} The transform controls of the clipping plane.
   */
  get controls() {
    return this._controls;
  }

  constructor(
    components: Components,
    world: World,
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    material: THREE.Material,
    size = 5,
    activateControls = true,
  ) {
    this.components = components;
    this.world = world;

    if (!world.renderer) {
      throw new Error("The given world must have a renderer!");
    }

    this.normal = normal;
    this.origin = origin;
    this._sizeMultiplier = size;

    // See the comment on the `enabled` setter above for why we read
    // the Clipper flag here. The Clipper itself ALSO calls
    // `setPlane(true, plane.three, localClippingPlanes)` right after
    // construction, so this is technically redundant — but threading
    // the flag here too keeps the plane's classification consistent
    // even if a subclass's constructor calls `setPlane` directly.
    const clipper = components.get(Clipper);
    world.renderer.setPlane(true, this.three, clipper.localClippingPlanes);

    this._planeMesh = SimplePlane.newPlaneMesh(size, material);
    this._helper = this.newHelper();
    this._controls = this.newTransformControls();

    this.three.setFromNormalAndCoplanarPoint(normal, origin);
    if (activateControls) {
      this.toggleControls(true);
    }

    this.updateScale();
    if (world.camera?.controls) {
      world.camera.controls.addEventListener("update", this.updateScale);
    }
  }

  private notifyManager = () => {
    const clipper = this.components.get(Clipper);
    const id = clipper.list.getKey(this);
    if (id) clipper.list.set(id, this);
  };

  /**
   * Sets the clipping plane's normal and origin from the given normal and point.
   * This method resets the clipping plane's state, updates the normal and origin,
   * and positions the helper object accordingly.
   *
   * @param normal - The new normal vector for the clipping plane.
   * @param point - The new origin point for the clipping plane.
   *
   * @returns {void}
   */
  setFromNormalAndCoplanarPoint(normal: THREE.Vector3, point: THREE.Vector3) {
    this.reset();
    this.placeHelper(normal, point);
    this.update();
  }

  /** {@link Updateable.update} */
  update = () => {
    if (!this._enabled) return;
    this.three.setFromNormalAndCoplanarPoint(
      this.normal,
      this._helper.position,
    );
    this.updateScale();
  };

  private updateScale = () => {
    const camera = this.world.camera?.three;
    if (!camera) return;
    this.followCamera(camera);
    if (!this.autoScale) return;
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);
    const distance = cameraPosition.distanceTo(this._helper.position);
    const scale = (distance / 7) * this._sizeMultiplier;
    this._planeMesh.scale.set(scale, scale, scale);
  };

  /**
   * The world may swap its camera object, as the ortho/perspective camera
   * does on a projection change. The controls size, orient and pick their
   * handles with their own camera, so they follow the world's current one.
   */
  private followCamera(camera: THREE.Camera) {
    if (this._controls.camera !== camera) {
      this._controls.camera = camera;
    }
  }

  /** {@link Disposable.dispose} */
  dispose() {
    this._enabled = false;

    // The world's camera getter throws once the world has been disposed, so
    // optional chaining alone isn't enough to make this safe. A disposed world
    // has already torn its camera controls down, so there's nothing to detach.
    if (!this.world.isDisposing && this.world.camera?.controls) {
      this.world.camera.controls.removeEventListener(
        "update",
        this.updateScale,
      );
    }

    this.onDraggingStarted.reset();
    this.onDraggingEnded.reset();
    this._helper.removeFromParent();

    if (this.world.renderer) {
      this.world.renderer.setPlane(false, this.three);
    }

    this._arrowBoundBox.removeFromParent();
    this._arrowBoundBox.geometry.dispose();
    this._planeMesh.geometry.dispose();
    this._controls.getHelper().removeFromParent();
    this._controls.dispose();
    this.onDisposed.trigger();
    this.onDisposed.reset();
  }

  private reset() {
    this.placeHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3());
  }

  /**
   * Moves the helper to the plane origin and faces it along the normal.
   * `lookAt` targets a world point, so the direction is taken from the
   * helper's new position; otherwise a helper away from the origin would tilt
   * toward the point `normal` whenever the normal changes.
   */
  private placeHelper(normal: THREE.Vector3, point: THREE.Vector3) {
    this.origin.copy(point);
    this._helper.position.copy(point);
    if (!this.normal.equals(normal)) {
      this.normal.copy(normal);
      this._helper.lookAt(point.clone().add(normal));
    }
    this._helper.updateMatrix();
  }

  protected toggleControls(state: boolean) {
    if (state) {
      if (this._controlsActive) return;
      this._controls.addEventListener("change", this.update);
      this._controls.addEventListener("dragging-changed", this.changeDrag);
    } else {
      this._controls.removeEventListener("change", this.update);
      this._controls.removeEventListener("dragging-changed", this.changeDrag);
    }
    this._controlsActive = state;
  }

  private newTransformControls() {
    if (!this.world.renderer) {
      throw new Error("No renderer found for clipping plane!");
    }
    const camera = this.world.camera.three;
    const container = this.world.renderer.three.domElement;
    const controls = new TransformControls(camera, container);
    this.initializeControls(controls);
    this.world.scene.three.add(controls.getHelper());
    return controls;
  }

  private initializeControls(controls: TransformControls) {
    controls.attach(this._helper);
    controls.showX = false;
    controls.showY = false;
    controls.setSpace("local");
    this.createArrowBoundingBox();
    controls.getHelper().children[0].children[0].add(this._arrowBoundBox);
    this.shapeAxis(controls);
  }

  /**
   * Shapes the plane's single visible axis: the stock translate gizmo draws
   * its shaft only from the center to the positive arrow and reaches half a
   * unit each way. A clipping plane moves both ways and sits on geometry, so
   * its axis carries a shaft spanning both arrows at half the stock reach,
   * with the same line thickness; the pickers follow the arrows. The gizmo
   * bakes placement into geometry and resets object transforms on every
   * update, so geometries are replaced rather than meshes transformed. The
   * shared stock geometries and the other axes are left untouched.
   */
  private shapeAxis(controls: TransformControls) {
    const root = controls.getHelper().children[0] as unknown as {
      gizmo?: { translate?: THREE.Object3D };
      picker?: { translate?: THREE.Object3D };
    };
    const half = SimplePlane.axisReach;
    const alongZ = (geometry: THREE.BufferGeometry, sign: number) =>
      geometry.rotateX((sign * Math.PI) / 2);
    const signOf = (mesh: THREE.Mesh) => {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      return box.min.z + box.max.z >= 0 ? 1 : -1;
    };
    for (const child of root.gizmo?.translate?.children ?? []) {
      // Duck-type: a consumer may resolve a second three module instance.
      if (child.name !== "Z" || !(child as THREE.Mesh).isMesh) continue;
      const mesh = child as THREE.Mesh;
      const parameters = (mesh.geometry as THREE.CylinderGeometry).parameters;
      if (!parameters) continue;
      if (parameters.radiusTop === parameters.radiusBottom) {
        mesh.geometry = alongZ(
          new THREE.CylinderGeometry(
            parameters.radiusTop,
            parameters.radiusBottom,
            half * 2,
            parameters.radialSegments,
          ),
          1,
        );
      } else {
        const sign = signOf(mesh);
        mesh.geometry = alongZ(
          new THREE.CylinderGeometry(
            parameters.radiusTop,
            parameters.radiusBottom,
            parameters.height,
            parameters.radialSegments,
          ).translate(0, half + parameters.height / 2, 0),
          sign,
        );
      }
    }
    for (const child of root.picker?.translate?.children ?? []) {
      if (child.name !== "Z" || !(child as THREE.Mesh).isMesh) continue;
      const mesh = child as THREE.Mesh;
      const parameters = (mesh.geometry as THREE.CylinderGeometry).parameters;
      if (!parameters) continue;
      const sign = signOf(mesh);
      const reach = half + SimplePlane.arrowLength;
      mesh.geometry = alongZ(
        new THREE.CylinderGeometry(
          parameters.radiusTop,
          parameters.radiusBottom,
          reach,
          parameters.radialSegments,
        ).translate(0, reach / 2, 0),
        sign,
      );
    }
  }

  private createArrowBoundingBox() {
    this._arrowBoundBox.geometry = new THREE.CylinderGeometry(0.18, 0.18, 1.2);
    this._arrowBoundBox.material = this._hiddenMaterial;
    this._arrowBoundBox.rotateX(Math.PI / 2);
    this._arrowBoundBox.updateMatrix();
    this._arrowBoundBox.geometry.applyMatrix4(this._arrowBoundBox.matrix);
  }

  private changeDrag = (event: any) => {
    this._visible = !event.value;
    this.preventCameraMovement();
    this.notifyDraggingChanged(event);
  };

  private notifyDraggingChanged(event: any) {
    if (event.value) {
      this.onDraggingStarted.trigger();
    } else {
      this.onDraggingEnded.trigger();
    }
  }

  private preventCameraMovement() {
    this.world.camera.enabled = this._visible;
  }

  private newHelper() {
    const helper = new THREE.Object3D();
    helper.position.copy(this.origin);
    helper.lookAt(this.origin.clone().add(this.normal));
    this._planeMesh.position.z += 0.01;
    helper.add(this._planeMesh);
    this.world.scene.three.add(helper);
    return helper;
  }

  private static newPlaneMesh(size: number, material: THREE.Material) {
    const planeGeom = new THREE.PlaneGeometry(1);
    const mesh = new THREE.Mesh(planeGeom, material);
    mesh.scale.set(size, size, size);
    return mesh;
  }
}
