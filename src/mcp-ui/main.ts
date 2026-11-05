import { mount } from "svelte";
import Shop from "./Shop.svelte";

mount(Shop, { target: document.getElementById("app") ?? document.body });
