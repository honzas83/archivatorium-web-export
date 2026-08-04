import { FeatureOptions, FeatureSettingInfo } from "./feature-options-base";

export class ShoppingBasketOptions extends FeatureOptions {
	checkoutEndpoint: string = "/api/checkout";
	info_checkoutEndpoint = new FeatureSettingInfo({
		description: "The server endpoint that creates Markdown subset zip downloads.",
	});
	maxCheckoutItems: number = 0;
	info_maxCheckoutItems = new FeatureSettingInfo({
		name: "Maximum checkout items",
		description: "Maximum number of unique Markdown documents that one checkout may contain. Use 0 for unlimited.",
	});

	constructor() {
		super();
		this.featureId = "shopping-basket";
	}
}
