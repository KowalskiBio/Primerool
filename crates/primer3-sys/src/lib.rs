//! Raw `bindgen`-generated FFI bindings to Primer3's thermodynamic
//! primitives (`thal`/`oligotm`/`thal_parameters`), compiled from the
//! vendored C sources by `build.rs`. Unsafe, unopinionated — `primer3-ffi`
//! provides the safe wrapper the rest of the workspace depends on.

#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
#![allow(dead_code)]

include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
