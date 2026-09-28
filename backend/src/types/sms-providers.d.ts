// Optional SMS provider modules — declare to avoid TS build errors
declare module '@alicloud/pop-core' {
  const Core: any;
  export default Core;
}

declare module 'tencentcloud-sdk-nodejs' {
  const tencentcloud: any;
  export = tencentcloud;
}
