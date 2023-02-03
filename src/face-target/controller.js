const {FaceMeshHelper} = require("./face-mesh-helper");
const {cv, waitCV} = require("../libs/opencv-helper.js");
const {Estimator} = require("./face-geometry/estimator.js");
const {createThreeFaceGeometry: _createThreeFaceGeometry} = require("./face-geometry/face-geometry");
const {positions: canonicalMetricLandmarks} = require("./face-geometry/face-data.js");
const {OneEuroFilter} = require('../libs/one-euro-filter.js');

const DEFAULT_FILTER_CUTOFF = 0.001; // 1Hz. time period in milliseconds
const DEFAULT_FILTER_BETA = 1;

class Controller {
  constructor({onUpdate = null, filterMinCF = null, filterBeta = null, isWebcamFacingUser = false}) {
    this.customFaceGeometries = [];
    this.estimator = null;
    this.lastEstimateResult = null;
    this.filterMinCF = filterMinCF === null ? DEFAULT_FILTER_CUTOFF : filterMinCF;
    this.filterBeta = filterBeta === null ? DEFAULT_FILTER_BETA : filterBeta;
    this.onUpdate = onUpdate;
    this.isWebcamFacingUser = isWebcamFacingUser;
    // 웹캠이 얼굴 방향인경우 화면 반전을 위한 캔버스 생성
    if (this.isWebcamFacingUser) {
      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('2d');
    }

    this.landmarkFilters = [];
    for (let i = 0; i < canonicalMetricLandmarks.length; i++) {
      this.landmarkFilters[i] = new OneEuroFilter({minCutOff: this.filterMinCF, beta: this.filterBeta});
    }
    this.faceMatrixFilter = new OneEuroFilter({minCutOff: this.filterMinCF, beta: this.filterBeta});
    this.faceScaleFilter = new OneEuroFilter({minCutOff: this.filterMinCF, beta: this.filterBeta});
  }

  async setup(input) {
    await waitCV();
    if (this.isWebcamFacingUser) {
      this.canvas.width = input.videoWidth;
      this.canvas.height = input.videoHeight;
    }
    this.faceMeshHelper = new FaceMeshHelper();
    this.estimator = new Estimator(input);
  }

  getCameraParams() {
    return {
      fov: this.estimator.fov * 180 / Math.PI,
      aspect: this.estimator.frameWidth / this.estimator.frameHeight,
      near: this.estimator.near,
      far: this.estimator.far
    }
  }

  copyImage(input) {
    this.context.save();
    this.context.scale(-1, 1);
    this.context.translate(-this.canvas.width, 0);
    this.context.drawImage(input, 0, 0, this.canvas.width, this.canvas.height);
    this.context.restore();
  }

  async dummyRun(input) {
    if (this.isWebcamFacingUser) {
      this.copyImage(input);
      await this.faceMeshHelper.detect(this.canvas);
    } else {
      await this.faceMeshHelper.detect(input);
    }
  }

  processVideo(input) {
    if (this.processingVideo) return;

    this.processingVideo = true;

    const doProcess = async () => {
      let results;
      if (this.isWebcamFacingUser) {
        this.copyImage(input);
        results = await this.faceMeshHelper.detect(this.canvas);
      } else {
        results = await this.faceMeshHelper.detect(input);
      }

      console.log("%c face len: " + results.multiFaceLandmarks.length, "color: cyan")

      if (results.multiFaceLandmarks.length === 0) {

        console.log("🚗 ... ");

        this.lastEstimateResult = null;
        if (this.onUpdate) {
          // estimateResult 값이 없으면 에러 발생 함
          this.onUpdate({
            hasFace: false,
            estimateResult: {
              metricLandmarks: null,
              faceMatrix: null,
              faceScale: null,
            }
          });
        }

        for (let i = 0; i < this.landmarkFilters.length; i++) {
          this.landmarkFilters[i].reset();
        }
        this.faceMatrixFilter.reset();
        this.faceScaleFilter.reset();
      } else {

        const landmarks = results.multiFaceLandmarks[0].map((l) => {
          return [l.x, l.y, l.z];
        });
        const estimateResult = this.estimator.estimate(landmarks);

        console.log(estimateResult)

        if (estimateResult.faceMatrix) {

          if (this.lastEstimateResult === null) {
            this.lastEstimateResult = estimateResult;
          } else {
            const lastMetricLandmarks = this.lastEstimateResult.metricLandmarks;
            const newMetricLandmarks = [];
            for (let i = 0; i < lastMetricLandmarks.length; i++) {
              newMetricLandmarks[i] = this.landmarkFilters[i].filter(Date.now(), estimateResult.metricLandmarks[i]);
            }

            const newFaceMatrix = this.faceMatrixFilter.filter(Date.now(), estimateResult.faceMatrix);
            const newFaceScale = this.faceScaleFilter.filter(Date.now(), [estimateResult.faceScale]);
            this.lastEstimateResult = {
              metricLandmarks: newMetricLandmarks,
              faceMatrix: newFaceMatrix,
              faceScale: newFaceScale[0],
            }
          }

          // faceMatrix 가 undefined 에러 발생 처리
          if (this.onUpdate && this.lastEstimateResult.faceMatrix) {
            this.onUpdate({hasFace: true, estimateResult: this.lastEstimateResult});
          } else {
            console.log(this.lastEstimateResult)
          }

          for (let i = 0; i < this.customFaceGeometries.length; i++) {
            this.customFaceGeometries[i].updatePositions(estimateResult.metricLandmarks);
          }
        }


      }
      if (this.processingVideo) {
        try {
          window.requestAnimationFrame(doProcess);
        } catch (e) {
          console.log("%c " + e, "color: red")
        }
      }
    }
    try {
      window.requestAnimationFrame(doProcess);
    } catch (e) {
      console.log("%c " + e, "color: red")
    }
  }

  stopProcessVideo() {
    this.processingVideo = false;
  }

  createThreeFaceGeometry(THREE) {
    const faceGeometry = _createThreeFaceGeometry(THREE);
    this.customFaceGeometries.push(faceGeometry);
    return faceGeometry;
  }

  getLandmarkMatrix(landmarkIndex) {
    const {metricLandmarks, faceMatrix, faceScale} = this.lastEstimateResult;

    const fm = faceMatrix;
    const s = faceScale;
    const t = [metricLandmarks[landmarkIndex][0], metricLandmarks[landmarkIndex][1], metricLandmarks[landmarkIndex][2]];
    const m = [
      fm[0] * s, fm[1] * s, fm[2] * s, fm[0] * t[0] + fm[1] * t[1] + fm[2] * t[2] + fm[3],
      fm[4] * s, fm[5] * s, fm[6] * s, fm[4] * t[0] + fm[5] * t[1] + fm[6] * t[2] + fm[7],
      fm[8] * s, fm[9] * s, fm[10] * s, fm[8] * t[0] + fm[9] * t[1] + fm[10] * t[2] + fm[11],
      fm[12] * s, fm[13] * s, fm[14] * s, fm[12] * t[0] + fm[13] * t[1] + fm[14] * t[2] + fm[15],
    ];
    return m;
  }
}

module.exports = {
  Controller
}
