export const ArrayMerger = (objValue: unknown, srcValue: unknown) => {
    if (Array.isArray(objValue)) return objValue.concat(srcValue)
}
